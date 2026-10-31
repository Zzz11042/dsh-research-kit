/**
 * dsh-research-kit — local-first research plugin for DeepSeek Harness.
 *
 * Registers three model-facing tools on `ctx.tools`:
 *   - `kb_grep`  — search KB file contents with a regex, scoped to the KB root
 *   - `kb_list`  — list KB files, newest-first, optional glob filter
 *   - `kb_save`  — save one fetched page as a new or updated resource file
 *
 * Pure Node ESM, zero runtime dependencies. The plugin talks to DSH only
 * through `ctx` (cordis Context):
 *   - `ctx.fs`        — the scoped filesystem service (read/list/resolve)
 *   - `ctx.tools`     — the tool registry
 *   - `process`       — for `kb_grep`, spawn a local `rg` or `grep` binary
 *
 * Configuration (via the bundle row's `config` field, see `cordis.patch.yml`):
 *   - `kbHome` (string, default `~/dsh-kb`) — KB root; `~` is expanded.
 *
 * Install as a DSH host bundle: `plugin_manager` → `install_bundle` with the
 * absolute package directory as `target`. The `dsh` bundle field points at
 * `cordis.patch.yml`.
 */

import { homedir } from 'node:os'
import { spawn } from 'node:child_process'

/**
 * Services this plugin requires from the deployment composition:
 *   - `tools`        — the tool registry
 *   - `fs`           — the scoped filesystem service (a dsh deployment always
 *                      provides one; `read`/`write`/`edit` depend on it too)
 *
 * `systemPrompt` is optional — the plugin degrades to tool registration only.
 */
export const inject = ['tools', 'fs']

const VERSION = '0.1.0'

/** Default KB root; `~` is expanded at tool-call time, not module load. */
const DEFAULT_KB_HOME = '~/dsh-kb'

/** Cap on KB grep matches retained inline by one `kb_grep` call. */
const KB_GREP_MAX_MATCHES = 250
/** Cap in bytes on one matched-line preview. */
const KB_GREP_MAX_LINE_BYTES = 2000

/**
 * Validate the plugin config row. Throws on unknown fields so a typo in
 * `kbHome` cannot silently fall back to the default.
 * @param {object} config - raw bundle row config.
 * @returns {{ kbHome: string }}
 */
export function resolveConfig(config) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    return { kbHome: DEFAULT_KB_HOME }
  }
  const allowed = new Set(['kbHome'])
  for (const key of Object.keys(config)) {
    if (!allowed.has(key)) {
      throw new Error(`dsh-research-kit: unknown config field "${key}" (allowed: kbHome)`)
    }
  }
  return {
    kbHome: config.kbHome === undefined || config.kbHome === null || String(config.kbHome).trim() === ''
      ? DEFAULT_KB_HOME
      : String(config.kbHome),
  }
}

/** Expand a leading `~` to the user home directory. */
function expandHome(path) {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return homedir() + path.slice(1)
  return path
}

/**
 * Resolve the KB root for the current call. Returns `{ kbHome, exists, target }`.
 * A missing root is a valid state — `kb_grep`/`kb_list` report it cleanly
 * and `kb_save` will create it on first write.
 * @param {object} ctx - cordis Context.
 * @param {{ kbHome: string }} resolved - resolved config.
 * @param {object} exec - execution context with `signal`.
 * @returns {Promise<{ kbHome: string, exists: boolean, target: object|undefined }>}
 */
async function resolveKbRoot(ctx, resolved, exec) {
  const kbHome = expandHome(resolved.kbHome)
  let target = undefined
  let exists = false
  try {
    target = await ctx.fs.resolve(kbHome, { signal: exec.signal })
    const info = target !== undefined ? await ctx.fs.stat(target, exec.signal) : undefined
    exists = info !== undefined && info.type === 'directory'
  } catch {
    exists = false
  }
  return { kbHome, exists, target }
}

// ---------------------------------------------------------------------------
// kb_grep — regex search over KB files
// ---------------------------------------------------------------------------

/**
 * Spawn a local command and capture stdout. Used by `kb_grep` to run
 * `rg` when the system has ripgrep, else fall back to `grep -rn`.
 * @param {string} bin
 * @param {string[]} argv
 * @param {{ cwd: string, timeoutMs: number, signal: AbortSignal }} opts
 * @returns {Promise<{ stdout: string, stderr: string, exitCode: number }>}
 */
function runCommand(bin, argv, { cwd, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, argv, { cwd, signal, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`dsh-research-kit: ${bin} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ stdout, stderr, exitCode: code ?? 1 })
    })
  })
}

/**
 * Detect an available ripgrep binary; return its name or null.
 * @param {AbortSignal} signal
 * @returns {Promise<string|null>}
 */
async function findRipgrep(signal) {
  try {
    const result = await runCommand('rg', ['--version'], {
      cwd: process.cwd(), timeoutMs: 3000, signal,
    })
    if (result.exitCode === 0) return 'rg'
  } catch {
    // not available
  }
  return null
}

/**
 * Parse `rg --json` NDJSON stdout into flat matches (mirrors the built-in
 * grep tool's record handling but without the ripgrep dependency).
 * @param {string} stdout
 * @returns {Array<{ path: string, lineNumber: number, line: string }>}
 */
function parseRipgrepMatches(stdout) {
  const matches = []
  for (const raw of stdout.split('\n')) {
    if (raw.length === 0) continue
    let record
    try {
      record = JSON.parse(raw)
    } catch {
      continue // skip non-JSON lines
    }
    if (record.type !== 'match') continue
    const data = record.data
    if (data === null || typeof data !== 'object') continue
    const pathText = typeof data.path === 'object' && data.path !== null ? data.path.text : undefined
    const lineNumber = typeof data.line_number === 'number' ? data.line_number : undefined
    const lines = data.lines
    if (typeof pathText !== 'string' || lineNumber === undefined || typeof lines !== 'object' || lines === null) continue
    const text = typeof lines.text === 'string' ? lines.text : '(binary or non-UTF-8 line)'
    matches.push({ path: pathText, lineNumber, line: text.replace(/\r?\n$/, '') })
  }
  return matches
}

/**
 * Run `grep -rn --include=<glob> <pattern> .` and parse the plain output.
 * @param {{ pattern: string, kbHome: string, include: string|undefined, signal: AbortSignal }} opts
 * @returns {Promise<Array<{ path: string, lineNumber: number, line: string }>>}
 */
async function runPlainGrep({ pattern, kbHome, include, signal }) {
  const argv = ['grep', '-rn', '-e', pattern]
  if (include !== undefined) argv.push(`--include=${include}`)
  argv.push('--', '.')
  const result = await runCommand('grep', argv, {
    cwd: kbHome, timeoutMs: 15000, signal,
  })
  const matches = []
  for (const raw of result.stdout.split('\n')) {
    if (raw.length === 0) continue
    // format: ./rel/path:123:line text
    const m = raw.match(/^([^:]+):(\d+):(.*)$/)
    if (m === null) continue
    matches.push({ path: m[1], lineNumber: Number(m[2]), line: m[3] })
  }
  return matches
}

/**
 * Group flat matches by file (first-seen order) into the model-facing body.
 * @param {Array<{ path: string, lineNumber: number, line: string }>} matches
 * @returns {string}
 */
function formatGrepMatches(matches) {
  const byFile = new Map()
  for (const match of matches) {
    const group = byFile.get(match.path)
    if (group !== undefined) group.push(match)
    else byFile.set(match.path, [match])
  }
  const sections = []
  for (const [path, group] of byFile) {
    sections.push(`${path}\n${group.map((m) => `Line ${m.lineNumber}: ${m.line}`).join('\n')}`)
  }
  return sections.join('\n\n')
}

/**
 * Truncate a match list to the inline caps. Mirrors the built-in grep tool:
 * keep the first N matches, preview each line to maxLineBytes.
 * @param {Array<{ path: string, lineNumber: number, line: string }>} matches
 * @returns {{ retained: Array<{ path: string, lineNumber: number, line: string }>, truncated: boolean, seen: number }}
 */
function retainMatches(matches) {
  const retained = matches.slice(0, KB_GREP_MAX_MATCHES)
  const capped = retained.map((m) => ({
    ...m,
    line: m.line.length > KB_GREP_MAX_LINE_BYTES
      ? m.line.slice(0, KB_GREP_MAX_LINE_BYTES) + '…'
      : m.line,
  }))
  return { retained: capped, truncated: matches.length > retained.length, seen: matches.length }
}

/**
 * Execute one `kb_grep` call.
 * @param {object} ctx - cordis Context.
 * @param {object} args - `{ pattern: string, include?: string }`.
 * @param {{ kbHome: string }} resolved - resolved config.
 * @param {{ signal: AbortSignal }} exec
 * @returns {Promise<object>}
 */
async function executeKbGrep(ctx, args, resolved, exec) {
  const pattern = String(args.pattern ?? '')
  if (pattern.length === 0) {
    throw new Error('kb_grep: pattern must be a non-empty string')
  }
  const include = args.include !== undefined ? String(args.include) : undefined

  const { kbHome, exists } = await resolveKbRoot(ctx, resolved, exec)
  if (!exists) {
    return {
      kbHome,
      exists: false,
      matches: [],
      note: `KB root ${kbHome} does not exist yet. Use kb_save to create it and add the first resource file.`,
    }
  }

  // Prefer ripgrep when available; fall back to plain grep.
  const rg = await findRipgrep(exec.signal)
  let rawMatches
  if (rg !== null) {
    const rgArgs = ['--json', `--regexp=${pattern}`]
    if (include !== undefined) rgArgs.push(`--glob=${include}`)
    rgArgs.push('--', '.')
    const result = await runCommand(rg, rgArgs, {
      cwd: kbHome, timeoutMs: 15000, signal: exec.signal,
    })
    rawMatches = parseRipgrepMatches(result.stdout)
  } else {
    rawMatches = await runPlainGrep({ pattern, kbHome, include, signal: exec.signal })
  }

  const { retained, truncated, seen } = retainMatches(rawMatches)
  const output = {
    kbHome,
    exists: true,
    matches: retained,
    matchCount: seen,
    truncated,
    engine: rg !== null ? 'ripgrep' : 'grep',
  }
  if (truncated) {
    output.note = `Showing ${retained.length} of ${seen} matches; narrow pattern or include to see more.`
  }
  return output
}

// ---------------------------------------------------------------------------
// kb_list — list KB files, newest-first
// ---------------------------------------------------------------------------

/**
 * Recursively list files under a directory via `ctx.fs.listDir`.
 * @param {object} ctx
 * @param {object} dirTarget
 * @param {object} exec
 * @param {number} [depth=0]
 * @returns {Promise<Array<{ path: string, size: number|undefined }>>}
 */
async function walkDir(ctx, dirTarget, exec, depth = 0) {
  if (depth > 8) return [] // guard against cyclic or too-deep trees
  const entries = await ctx.fs.listDir(dirTarget, exec.signal)
  const results = []
  for (const entry of entries) {
    const name = entry.name
    const isDir = entry.type === 'directory'
    const childPath = dirTarget.displayPath.endsWith('/')
      ? dirTarget.displayPath + name
      : dirTarget.displayPath + '/' + name
    if (isDir) {
      // Only descend into non-hidden directories; skip node_modules, .git.
      if (name.startsWith('.') || name === 'node_modules') continue
      const childTarget = await ctx.fs.resolve(childPath, { signal: exec.signal })
      if (childTarget !== undefined) {
        const info = await ctx.fs.stat(childTarget, exec.signal)
        if (info !== undefined && info.type === 'directory') {
          const sub = await walkDir(ctx, childTarget, exec, depth + 1)
          results.push(...sub)
        }
      }
    } else {
      results.push({ path: childPath, size: entry.size })
    }
  }
  return results
}

/**
 * Execute one `kb_list` call.
 * @param {object} ctx
 * @param {object} args - `{ include?: string, limit?: number }`
 * @param {{ kbHome: string }} resolved
 * @param {{ signal: AbortSignal }} exec
 * @returns {Promise<object>}
 */
async function executeKbList(ctx, args, resolved, exec) {
  const include = args.include !== undefined ? String(args.include) : undefined
  const limit = args.limit !== undefined ? Math.max(1, Number(args.limit)) : 50

  const { kbHome, exists, target } = await resolveKbRoot(ctx, resolved, exec)
  if (!exists || target === undefined) {
    return { kbHome, exists: false, files: [], note: `KB root ${kbHome} does not exist yet.` }
  }

  let all = await walkDir(ctx, target, exec)

  // Filter by include glob (simple suffix match on basename; a full
  // glob engine is out of scope for v0.1).
  if (include !== undefined && include.length > 0) {
    const suffix = include.startsWith('*') ? include.slice(1) : include
    all = all.filter((f) => {
      const base = f.path.split('/').pop() ?? f.path
      return base.endsWith(suffix) || f.path.endsWith(suffix)
    })
  }

  // Sort: by path descending (newest files land in 06-资源/ with a
  // date-prefixed name, so reverse-lexicographic ≈ newest-first).
  all.sort((a, b) => b.path.localeCompare(a.path))
  const files = all.slice(0, limit)
  const total = all.length

  return {
    kbHome,
    total,
    limit,
    files,
    ...(total > limit ? { note: `Showing ${limit} of ${total} files; raise limit or narrow include.` } : {}),
  }
}

// ---------------------------------------------------------------------------
// kb_save — save one fetched page as a resource file
// ---------------------------------------------------------------------------

/**
 * Validate and build the frontmatter block for `kb_save`.
 * @param {object} args
 * @returns {{ source: string, fetched: string, task: string, tags: string[] }}
 */
function parseKbSaveArgs(args) {
  const source = String(args.source ?? '').trim()
  if (source.length === 0) throw new Error('kb_save: source (the original URL) is required')
  const fetched = args.fetched !== undefined ? String(args.fetched).trim() : new Date().toISOString().slice(0, 10)
  const task = args.task !== undefined ? String(args.task).trim() : 'unspecified'
  let tags = []
  if (args.tags !== undefined) {
    if (Array.isArray(args.tags)) {
      tags = args.tags.map((t) => String(t).trim()).filter((t) => t.length > 0)
    } else if (typeof args.tags === 'string') {
      tags = args.tags.split(',').map((t) => t.trim()).filter((t) => t.length > 0)
    }
  }
  return { source, fetched, task, tags }
}

/**
 * Slugify a source URL or arbitrary string into a kebab-case filename
 * fragment.
 * @param {string} input
 * @returns {string}
 */
function slugify(input) {
  const cleaned = String(input)
    .replace(/^https?:\/\//, '')
    .replace(/[?#].*$/, '')
    .toLowerCase()
  const segments = cleaned.split('/').filter((s) => s.length > 0)
  const raw = segments.length > 0 ? segments[segments.length - 1] : cleaned.replace(/[^a-z0-9]/g, '')
  const slug = raw
    .replace(/\.html?$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  return slug.length > 0 ? slug : 'unnamed'
}

/**
 * Ensure a directory exists under the KB root, creating it if absent.
 * Uses `ctx.fs.resolve` + a probe write; some backends create parents on write.
 * @param {object} ctx
 * @param {string} dirPath
 * @param {{ signal: AbortSignal }} exec
 * @returns {Promise<object>} the resolved directory target.
 */
async function ensureDir(ctx, dirPath, exec) {
  let target = await ctx.fs.resolve(dirPath, { signal: exec.signal })
  if (target !== undefined) {
    const info = await ctx.fs.stat(target, exec.signal)
    if (info !== undefined && info.type === 'directory') return target
  }
  // Try to create by writing a marker file inside the target path.
  const probe = dirPath + '/.keep'
  const probeTarget = await ctx.fs.resolve(probe, { signal: exec.signal })
  if (probeTarget !== undefined) {
    try {
      await ctx.fs.writeText(probeTarget, '', undefined, exec.signal)
    } catch {
      // backend may not create parent dirs; caller will surface the error
    }
  }
  target = await ctx.fs.resolve(dirPath, { signal: exec.signal })
  if (target === undefined) {
    throw new Error(`dsh-research-kit: cannot resolve directory ${dirPath}`)
  }
  return target
}

/**
 * Execute one `kb_save` call.
 * @param {object} ctx
 * @param {object} args - `{ source, fetched?, task?, tags?, body }`
 * @param {{ kbHome: string }} resolved
 * @param {{ signal: AbortSignal }} exec
 * @returns {Promise<object>}
 */
async function executeKbSave(ctx, args, resolved, exec) {
  const body = args.body !== undefined ? String(args.body) : ''
  if (body.length === 0) {
    throw new Error('kb_save: body (the distilled content to persist) is required and must be non-empty')
  }
  const meta = parseKbSaveArgs(args)

  const { kbHome } = await resolveKbRoot(ctx, resolved, exec)
  const resourceDir = await ensureDir(ctx, kbHome + '/06-资源', exec)

  const today = meta.fetched.length === 10 ? meta.fetched : new Date().toISOString().slice(0, 10)
  const slug = slugify(meta.source)
  const fileName = `${today}_${slug}.md`
  const filePath = resourceDir.displayPath.endsWith('/')
    ? resourceDir.displayPath + fileName
    : resourceDir.displayPath + '/' + fileName

  const target = await ctx.fs.resolve(filePath, { signal: exec.signal })
  let isUpdate = false
  if (target !== undefined) {
    const info = await ctx.fs.stat(target, exec.signal)
    if (info !== undefined && info.type === 'file') {
      isUpdate = true
    }
  }

  const frontmatter = [
    '---',
    `source: ${meta.source}`,
    `fetched: ${meta.fetched}`,
    `task: ${meta.task}`,
    `tags: [${meta.tags.join(', ')}]`,
    '---',
    '',
    body,
    '',
  ].join('\n')

  const writeTarget = target !== undefined ? target : await ctx.fs.resolve(filePath, { signal: exec.signal })
  await ctx.fs.writeText(writeTarget, frontmatter, undefined, exec.signal)

  return {
    path: filePath,
    updated: isUpdate,
    source: meta.source,
    fetched: meta.fetched,
    task: meta.task,
    tags: meta.tags,
  }
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

/**
 * Build the three `kb_*` tool definitions for registration on `ctx.tools`.
 * Each object has the shape the tool registry expects.
 * @param {object} ctx - cordis Context.
 * @param {{ kbHome: string }} resolved - resolved config.
 * @returns {Array<object>} the three ToolDefinition objects.
 */
export function buildKbTools(ctx, resolved) {
  const kbGrep = {
    name: 'kb_grep',
    description:
      'Search the local DSH knowledge base (markdown files) with a regular expression. '
      + 'Returns matching lines with file paths and line numbers, grouped by file. '
      + `Uses ripgrep when available, falls back to grep. Cap: ${KB_GREP_MAX_MATCHES} matches.`,
    parameters: {
      pattern: {
        type: 'string',
        required: true,
        description: 'Regular expression to search for (ripgrep syntax).',
      },
      include: {
        type: 'string',
        description: 'One glob filter for which files to search (e.g. "*.md"). Not a list.',
      },
    },
    timeoutMs: 20000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          kbHome: { type: 'string', required: true },
          exists: { type: 'boolean', required: true },
          matches: { type: 'array', required: true },
          matchCount: { type: 'integer' },
          truncated: { type: 'boolean' },
          engine: { type: 'string' },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.matches.length === 0
          ? (value.note ?? 'No matches found')
          : `Found ${value.matchCount ?? value.matches.length} matches in KB ${value.kbHome}:\n\n` + formatGrepMatches(value.matches),
      }],
    },
    execute: (args, exec) => executeKbGrep(ctx, args, resolved, exec),
    isConcurrencySafe: () => true,
  }

  const kbList = {
    name: 'kb_list',
    description:
      'List files in the local DSH knowledge base, newest-first. '
      + 'Optional include glob and limit. Pure filesystem walk, no subprocess.',
    parameters: {
      include: {
        type: 'string',
        description: 'Optional glob filter (e.g. "*.md" matches only markdown files).',
      },
      limit: {
        type: 'integer',
        description: 'Maximum files to return. Default 50.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          kbHome: { type: 'string', required: true },
          total: { type: 'integer', required: true },
          limit: { type: 'integer', required: true },
          files: { type: 'array', required: true },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.files.length === 0
          ? (value.note ?? 'KB is empty or does not exist')
          : `KB ${value.kbHome} — ${value.total} file(s), showing ${value.files.length}:\n`
            + value.files.map((f) => `  ${f.path}${f.size !== undefined ? ` (${f.size} B)` : ''}`).join('\n'),
      }],
    },
    execute: (args, exec) => executeKbList(ctx, args, resolved, exec),
    isConcurrencySafe: () => true,
  }

  const kbSave = {
    name: 'kb_save',
    description:
      'Save one fetched page as a new or updated resource file in the KB '
      + 'under 06-资源/. Validates frontmatter (source/fetched/task/tags). '
      + 'Use this for every web_fetch that returned material you actually used.',
    parameters: {
      source: {
        type: 'string',
        required: true,
        description: 'The original URL the content was fetched from (for the source: frontmatter field).',
      },
      body: {
        type: 'string',
        required: true,
        description: 'The distilled/quoted content to persist (markdown body, without the frontmatter).',
      },
      fetched: {
        type: 'string',
        description: 'ISO date string (YYYY-MM-DD). Defaults to today.',
      },
      task: {
        type: 'string',
        description: 'Short task slug for the task: frontmatter field.',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Tag strings for the tags: frontmatter field.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          updated: { type: 'boolean', required: true },
          source: { type: 'string', required: true },
          fetched: { type: 'string', required: true },
          task: { type: 'string', required: true },
          tags: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.updated ? 'Updated' : 'Created'} KB resource: ${value.path}\n`
          + `source: ${value.source}\nfetched: ${value.fetched}\ntask: ${value.task}\ntags: [${value.tags.join(', ')}]`,
      }],
    },
    execute: (args, exec) => executeKbSave(ctx, args, resolved, exec),
    isConcurrencySafe: () => false,
  }

  return [kbGrep, kbList, kbSave]
}

// ---------------------------------------------------------------------------
// Plugin entry point
// ---------------------------------------------------------------------------

/**
 * DSH plugin apply function. Registers the three `kb_*` tools and a
 * system-prompt section.
 * @param {object} ctx - cordis Context.
 * @param {object} [config] - bundle row config; see `resolveConfig`.
 */
export function apply(ctx, config = {}) {
  const resolved = resolveConfig(config)

  const tools = buildKbTools(ctx, resolved)
  const disposers = []
  for (const tool of tools) {
    disposers.push(ctx.tools.register(tool))
  }

  // Teardown: remove all tool registrations when the plugin is disposed.
  ctx.effect(function* () {
    yield () => {
      for (let i = disposers.length - 1; i >= 0; i -= 1) disposers[i]()
    }
  }, 'dsh-research-kit.tools')

  if (ctx.logger !== undefined) {
    ctx.logger.info(`dsh-research-kit v${VERSION}: registered kb_grep, kb_list, kb_save (kbHome=${resolved.kbHome})`)
  }

  // Optional system-prompt section so the model knows the tools exist.
  // Guarded: a deployment without `systemPrompt` still boots fine.
  try {
    if (ctx.inject !== undefined) {
      ctx.inject(['systemPrompt'], (inner) => {
        inner.systemPrompt.section({
          name: 'tool:kb-research',
          order: 50,
          text: 'Use kb_grep to search the local DSH knowledge base before any web search. '
            + 'Use kb_list to see what is already cached. Use kb_save to persist every web_fetch '
            + 'result you actually used. Never skip kb_save when a fetch returned material you relied on.',
        })
      })
    }
  } catch {
    // `systemPrompt` service not mounted; tool registration is still valid.
  }
}

export default { apply, resolveConfig, buildKbTools, VERSION }
