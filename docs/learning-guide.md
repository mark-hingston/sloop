# Learning guide

This guide explains where durable learnings should live and how to keep them well-maintained.

## Progressive disclosure model

The repo uses a two-tier memory model:

| Location | What goes here |
|---|---|
| `AGENTS.md` | Top-level, high-signal guidance — the first thing an agent reads |
| `docs/` | Deep-dive detail for specific topics — linked from `AGENTS.md` |

Agents should write to `AGENTS.md` for brief, cross-cutting facts. When a topic warrants more than a few bullets, create or update a file in `docs/` and add a markdown link to it in `AGENTS.md` (e.g. `See [hooks design](docs/hooks.md)`).

## What belongs in AGENTS.md

Good candidates:
- Coding conventions that apply across the repo
- Build, test, and release habits that are easy to forget
- Architectural guardrails
- Short file- or subsystem-specific notes with a pointer to the relevant `docs/` file

Avoid putting these in AGENTS.md:
- Temporary debugging notes
- One-off task plans
- Stale migrations or rollout checklists
- Long transcripts of what happened in a single session
- Detailed how-it-works explanations (put those in `docs/`)

## What belongs in docs/

Good candidates:
- Hook design and behavior (`docs/hooks.md`)
- Eval scoring details and rubric (`docs/eval.md`)
- Per-subsystem conventions that need more than a few bullets
- Architecture diagrams or decision records

Avoid putting these in docs/:
- Transient session notes
- Content that duplicates AGENTS.md without adding depth

## Maintenance pattern

- Keep AGENTS.md sections short and scannable
- Prefer bullets over prose
- Record facts, not speculation
- Update or delete outdated guidance instead of endlessly appending
- When a docs/ topic grows stale, update it in place rather than adding a new file

## How the eval loop promotes learnings

At session end, `markdown-eval.mjs` scores the session. Records rated `promote` trigger an automated `copilot -p` invocation using the prompt template at `.github/hooks/prompts/promote-learnings.md`. That agent reads the session summary and updates `AGENTS.md` and any relevant `docs/` files.

See `docs/eval.md` for scoring details.
