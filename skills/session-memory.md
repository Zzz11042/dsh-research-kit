---
name: session-memory
description: "Answer 'what did I do before / what was in a past session' from DSH's prior-session history instead of re-asking the model. Use session_search to locate relevant sessions, then session_event_search / session_event_trace / session_trace for the exact evidence before quoting or building on it."
whenToUse: "When the user asks what was done previously, what a past session concluded, or whether a topic was already investigated; or before redoing work that may already exist in a prior session."
---

# Session Memory Protocol

DSH keeps durable session history per workspace. Before redoing research or re-deriving a past conclusion, query the history so the answer (and its evidence) is grounded in what actually happened.

## When to use

- "What did I do / find / decide before on X?"
- "Did we already investigate Y?"
- Before starting a task that overlaps a prior session's scope.
- Before claiming something is "known" that you have not verified in the current context.

## Tools

| Tool | What it returns |
|---|---|
| `session_search` | The strongest matching event from each prior session matching a full-text query, in the caller workspace. Workspace-scoped. |
| `session_event_search` | Prior events inside one authorized session, filterable by seq range, time range, event types, surfaces. |
| `session_event_read` | One full unabridged event plus optional neighboring raw-event summaries. |
| `session_event_trace` | Every direct replacement/relationship to a cited source event in one session. |
| `session_trace` | The authorized session lineage around one session, including visible ancestor/descendant relationships. |

All of these take an optional `session_id`; omit it for the current session. Results are cursor-free and workspace-scoped.

## Workflow

1. **Start broad.** `session_search` with a literal full-text query over the topic. Include enough words to be specific but not so many that nothing matches.
2. **Narrow to one session.** When a hit is useful, `session_trace` to see the lineage, or `session_event_search` on that session with `event_types` / `seq_from` / `seq_to` filters.
3. **Read the exact evidence.** `session_event_read` the target event (with `before`/`after` for context) before quoting it.
4. **Trace replacements.** If the event looks like a summary or a redacted result, `session_event_trace` to find the original it replaced or that it replaced.
5. **Cite the session.** In the answer, name the session (id or title) and the event, so the user can verify.

## Rules

- Do not treat a prior-session answer as automatically correct in the current context — re-verify load-bearing facts against current files/tools.
- Do not load whole sessions into context. Read the events you need, not the transcript.
- If `session_search` returns nothing, say so and fall back to the local knowledge base (`local-first-research` skill) or the web.
- Sessions live under `~/.dsh/sessions/<workspace>/session-*/` as zstd-compressed JSONL; query them via the session tools, never read the files directly.
