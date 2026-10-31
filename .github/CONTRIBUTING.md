# Contributing to dsh-research-kit

This repo is a DSH (DeepSeek Harness) host bundle plus two skills.

## Layout

- `plugin/` — the DSH host plugin (`index.js`, `package.json`, `cordis.patch.yml`, locale, icon). Pure Node ESM, zero runtime dependencies. Talk to DSH only through `ctx.fs` / `ctx.tools`.
- `skills/` — two DSH skills (`local-first-research`, `session-memory`). Kebab-case names; drop into any DSH skills root.
- `README.md` — install + KB layout.

## Adding a tool

1. Add a `kb_*` executor function in `plugin/index.js` returning a lossless JSON value.
2. Add its ToolDefinition entry in `buildKbTools` (schema + `render`).
3. Register it in `apply()` and add a test in `plugin/test/index.js` against a fixture KB.
4. Keep it dependency-free: use `ctx.fs` and local spawn, no npm runtime deps.

## Tests

```sh
cd plugin
node --check index.js
node test/index.js
```

The test harness is plain `node:assert` with a mock `ctx.fs`; no framework.
