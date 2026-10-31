/**
 * Minimal test harness for dsh-research-kit — runs against a fixture KB
 * and a mock `ctx.fs`. No external test framework; just node.
 *
 * Run: `node test/index.js`
 */

import { strict as assert } from 'node:assert'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, statSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const mod = await import(pathToFileURL(new URL('../index.js', import.meta.url).pathname))

/** Build a fixture KB tree. */
function makeKb() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-kit-test-'))
  mkdirSync(join(root, '01-知识卡片'), { recursive: true })
  mkdirSync(join(root, '06-资源'), { recursive: true })
  writeFileSync(join(root, '01-知识卡片', 'fs-seam.md'),
    '# fs seam\nctx.fs is the filesystem service.\n', 'utf-8')
  writeFileSync(join(root, '06-资源', '2026-10-31_research.md'),
    '---\nsource: https://example.com\nfetched: 2026-10-31\n---\n\nSome cached content.\n', 'utf-8')
  return root
}

/**
 * A mock ctx.fs backed by node:fs against a real directory.
 * `displayPath` is always an absolute path (the local backend normalizes + realpaths).
 */
function mockFs(root) {
  return {
    resolve(path) {
      const abs = path.startsWith('/') ? path : join(root, path)
      return { targetKey: abs, displayPath: abs }
    },
    stat(target) {
      try {
        const info = statSync(target.displayPath)
        return { type: info.isDirectory() ? 'directory' : 'file', size: info.size }
      } catch {
        return undefined
      }
    },
    readText(target) {
      return readFileSync(target.displayPath, 'utf-8')
    },
    writeText(target, content) {
      writeFileSync(target.displayPath, content, 'utf-8')
      return { version: 1 }
    },
    listDir(target) {
      const entries = readdirSync(target.displayPath)
      return entries.map((name) => {
        const p = join(target.displayPath, name)
        const s = statSync(p)
        return { name, type: s.isDirectory() ? 'directory' : 'file', size: s.size }
      })
    },
  }
}

/** A mock ctx.tools that captures registrations. */
function mockTools() {
  const registered = []
  return {
    registered,
    register(tool) {
      registered.push(tool)
      return () => {
        const i = registered.indexOf(tool)
        if (i !== -1) registered.splice(i, 1)
      }
    },
  }
}

function mockEffect() {
  return function* effect(gen, label) {
    const g = gen()
    while (true) {
      const step = g.next()
      if (step.done) return
      // collect any yielded disposers (no-op in tests)
    }
  }
}

async function testResolveConfig() {
  assert.deepEqual(mod.resolveConfig(null), { kbHome: '~/dsh-kb' })
  assert.deepEqual(mod.resolveConfig({ kbHome: '/custom/kb' }), { kbHome: '/custom/kb' })
  assert.deepEqual(mod.resolveConfig({}), { kbHome: '~/dsh-kb' })
  assert.throws(() => mod.resolveConfig({ kbRoot: 'x' }), /unknown config field/)
  console.log('  ✓ resolveConfig')
}

async function testBuildKbTools() {
  const tools = mod.buildKbTools({}, { kbHome: '/tmp' })
  assert.equal(tools.length, 3)
  assert.equal(tools[0].name, 'kb_grep')
  assert.equal(tools[1].name, 'kb_list')
  assert.equal(tools[2].name, 'kb_save')
  for (const t of tools) {
    assert.equal(typeof t.execute, 'function')
    assert.equal(typeof t.output.render, 'function')
  }
  console.log('  ✓ buildKbTools')
}

async function testApplyRegistersTools() {
  const ctx = {
    tools: mockTools(),
    effect: mockEffect(),
    logger: { info() {} },
  }
  mod.apply(ctx, { kbHome: '/tmp/fake-kb' })
  assert.equal(ctx.tools.registered.length, 3)
  console.log('  ✓ apply registers 3 tools')
}

async function testKbGrep() {
  const root = makeKb()
  const fs = mockFs(root)
  const ctx = { fs }
  const resolved = { kbHome: root }
  const exec = { signal: new AbortController().signal }

  const result = await mod.buildKbTools(ctx, resolved)[0].execute({ pattern: 'ctx.fs' }, exec)
  assert.equal(result.exists, true)
  assert.ok(result.matches.length >= 1, 'expected at least one match')
  console.log('  ✓ kb_grep finds matches:', result.matchCount)
}

async function testKbList() {
  const root = makeKb()
  const fs = mockFs(root)
  const ctx = { fs }
  const resolved = { kbHome: root }
  const exec = { signal: new AbortController().signal }

  const result = await mod.buildKbTools(ctx, resolved)[1].execute({}, exec)
  assert.equal(result.total, 2, 'expected 2 fixture files')
  assert.ok(result.files[0].path.endsWith('.md'))
  console.log('  ✓ kb_list returns', result.total, 'files')
}

async function testKbSave() {
  const root = makeKb()
  const fs = mockFs(root)
  const ctx = { fs }
  const resolved = { kbHome: root }
  const exec = { signal: new AbortController().signal }

  const result = await mod.buildKbTools(ctx, resolved)[2].execute({
    source: 'https://example.com/some-article',
    body: '# Distilled content\n\nKey points here.',
    task: 'test-task',
    tags: ['a', 'b'],
  }, exec)

  assert.ok(result.path.includes('06-资源'), 'save target should be under 06-资源/')
  assert.equal(result.updated, false)
  // Verify file was written
  const content = readFileSync(result.path, 'utf-8')
  assert.ok(content.includes('source: https://example.com/some-article'))
  assert.ok(content.includes('task: test-task'))
  assert.ok(content.includes('tags: [a, b]'))
  console.log('  ✓ kb_save writes', result.path)
}

async function main() {
  console.log('dsh-research-kit tests\n')
  await testResolveConfig()
  await testBuildKbTools()
  await testApplyRegistersTools()
  await testKbGrep()
  await testKbList()
  await testKbSave()
  console.log('\nAll tests passed.')
}

main().catch((err) => {
  console.error('TEST FAILED:', err)
  process.exit(1)
})
