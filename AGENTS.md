# Copilot instructions

This file is the top-level durable memory for this repository. Keep it short and scannable.
For deeper detail on specific topics, see the `docs/` folder.

## At session start

1. Read `.github/hooks/.runtime/prime.txt` if it exists — it contains the latest eval summary and last session handoff.
2. Treat this file as the source of truth for top-level guidance.

## While working

1. Follow the guidance in this file unless the user explicitly overrides it.
2. When you discover a durable fact, use **progressive disclosure**:
   - Brief, cross-cutting facts → add a short bullet here.
   - Detailed or topic-specific guidance → update the relevant `docs/` file and add a one-line markdown link here (e.g. `See [hooks design](docs/hooks.md)`).
3. Treat `.github/hooks/.runtime/` files as local tactical artifacts, not durable memory.

## Before finishing

1. Add or refine only durable guidance that is grounded in the work you completed.
2. Remove or rewrite stale instructions so this file stays high-signal.
3. Avoid recording one-off plans, temporary debugging breadcrumbs, or speculative notes.

## Docs index

| File | Topic |
|---|---|
| `docs/hooks.md` | Hook design, fire-and-forget pattern, runtime file layout |
| `docs/eval.md` | Eval scoring rubric, recommendations, promotion flow |
| `docs/learning-guide.md` | What goes in AGENTS.md vs docs/, maintenance patterns |

## Suggested sections

- Project overview
- Build and test workflow
- Coding conventions
- Architecture guardrails
- Durable learnings by area (with refs to docs/ for detail)

## Durable learnings

- Keep entries here short, specific, and cross-cutting.
- Point at `docs/` files for anything requiring more than a few bullets.
