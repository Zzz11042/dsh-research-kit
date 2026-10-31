# dsh-research-kit

Local-first research toolkit for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH / `dsh`).

One DSH host plugin and two DSH skills that turn external web research into a managed, compounding knowledge base:

| Piece | Kind | What it is |
|---|---|---|
| `dsh-research-kit` | DSH host plugin | Registers three model-facing tools — `kb_grep`, `kb_list`, `kb_save` — that read and write a markdown knowledge base through the scoped `ctx.fs` filesystem service. Pure Node ESM, zero runtime dependencies, no network. |
| `local-first-research` | DSH skill | The protocol: **query local caches first**, fall back to the web only when local is insufficient, and **persist everything fetched back to local storage** so knowledge compounds across sessions. |
| `session-memory` | DSH skill | The protocol: answer "what did I do before?" from **prior DSH sessions** (`session_search`, `session_event_search`, `session_event_trace`, `session_trace`) instead of re-asking the model for context it already has. |

The idea: an agent that keeps a local knowledge base stops paying full web cost for facts it already has, and every fetched page becomes a reusable, citable, versioned markdown resource instead of a one-shot context blob.

## Layout

```
dsh-research-kit/
├── plugin/            # the DSH host bundle (kb_grep / kb_list / kb_save)
│   ├── index.js       # entry point — apply(ctx, config)
│   ├── package.json   # dsh.bundle manifest
│   ├── cordis.patch.yml
│   ├── icon.svg
│   ├── locale/{en,zh}.json
│   └── test/index.js  # node test harness (no framework)
├── skills/
│   ├── local-first-research.md
│   └── session-memory.md
├── LICENSE
└── README.md
```

## Install

The plugin is a DSH host bundle. Copy or git-clone this repo's `plugin/` directory, then install through `plugin_manager` (`install_bundle` with the absolute package directory as `target`). The plugin's `dsh.bundle.patch` field points at `cordis.patch.yml`, which inserts one plugin row.

Install the two skills by copying the markdown files into a skills root DSH scans (`<dshHome>/skills`, `<projectRoot>/.dsh/skills`, or `Config.customSkillDirs`):

```sh
cp skills/local-first-research.md ~/.dsh/skills/
cp skills/session-memory.md      ~/.dsh/skills/
```

Skill names are kebab-case; `local-first-research` and `session-memory` satisfy that.

## Knowledge base layout

The plugin expects a KB rooted at `~/dsh-kb` by default (override via the plugin `config.kbHome` field). Layout:

```
~/dsh-kb/
├── 01-知识卡片/          # atomic concept cards
├── 02-任务复盘/          # per-task postmortems
├── 05-项目/             # project notes
├── 06-资源/             # cached web material (one .md per fetch, frontmatter: source/fetched/task/tags)
└── 07-会话导出/          # exported session summaries
```

`kb_save` writes one `.md` file per fetch with `source` / `fetched` / `task` / `tags` frontmatter. Do not duplicate a resource file that already exists for the same `source:` URL — update it in place instead.

## Plugin tools

| Tool | What it does | Notes |
|---|---|---|
| `kb_grep` | Search KB file contents with a regular expression (ripgrep syntax). Returns matching lines grouped by file. | Uses `rg` when available on the host, falls back to `grep -rn`. Scoped to the KB root. |
| `kb_list` | List KB files, newest-first. Optional `include` suffix filter and `limit`. | Pure `ctx.fs.listDir` walk; no subprocess. |
| `kb_save` | Save one fetched page as a new or updated `06-资源/<yyyy-mm-dd>_<slug>.md` resource file. Validates frontmatter fields. | Path construction is owned by the tool; the model never assembles KB paths itself. |

## Why local-first?

Web search is slow, rate-limited, and non-deterministic. A local knowledge base:

- is a file system — `grep` is a tool every agent already has;
- is inspectable and diff-able (git-friendly);
- compounds: the more you run the workflow, the less you rely on the web;
- keeps the agent honest — it must show *what* it found locally before it is allowed to spend web tokens.

The `local-first-research` skill encodes that discipline; `dsh-research-kit` makes the "save what you found" step a one-tool-call instead of a shell chain.

## Dev

```sh
cd plugin
node --check index.js            # syntax
node test/index.js               # run the test harness
```

Tests use plain Node assertions against a fixture KB in `plugin/test/`; no framework.

## License

MIT
