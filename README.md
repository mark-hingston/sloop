# Copilot markdown-first self-learning hook pack

A lightweight Copilot hook pack that gives your repository a self-improving memory loop — no external services required. Durable project memory lives in `AGENTS.md` and the `docs/` folder, committed to git. The hooks capture session breadcrumbs, score them, and promote high-signal learnings back into those files automatically.

## What it does

- **Session start** — writes `prime.txt` with recent eval summary and last session handoff so Copilot has context before it starts work (Copilot reads `AGENTS.md` and `docs/` directly; `prime.txt` supplements with session history only)
- **During session** — captures prompt and tool breadcrumbs in the background
- **Session end** — writes a structured session record and refreshes `prime.txt`; then background-spawns the eval loop, which scores the record and triggers a `copilot -p` promotion for any high-signal session

## Progressive disclosure model

Durable memory uses two tiers so `AGENTS.md` stays short and scannable:

| Location | What goes here |
|---|---|
| `AGENTS.md` | Top-level, cross-cutting guidance — the first thing an agent reads |
| `docs/` | Deep-dive detail for specific topics, linked from `AGENTS.md` |

See [docs/learning-guide.md](docs/learning-guide.md) for full guidance on what belongs where.

## Files

| File | Purpose |
|---|---|
| `.github/hooks/markdown-copilot.json` | Hook configuration — tells Copilot which scripts to run and when |
| `.github/hooks/markdown-self-learning.mjs` | Hook runner — captures session events and writes records |
| `.github/hooks/markdown-eval.mjs` | Evaluator — scores records and triggers promotions |
| `.github/hooks/prompts/promote-learnings.md` | Prompt template used when spawning a learning promotion |
| `AGENTS.md` | Top-level durable memory — Copilot reads and updates this |
| `docs/` | Deep-dive docs linked from `AGENTS.md` |

## Getting started

**Prerequisites:** Node.js must be available (`node --version`).

**Copy into your repo:**

```bash
cp -r .github/hooks/ docs/ AGENTS.md README.md /path/to/your-repo/
```

**Then in your repo:**

1. Edit `AGENTS.md` — replace the placeholder sections with your project's conventions, build workflow, and architecture guardrails.
2. Edit `docs/learning-guide.md` — remove or adapt sections that don't fit your project.
3. Commit everything: `.github/hooks/`, `docs/`, and `AGENTS.md`.
4. Decide who is allowed to update durable docs: humans only, agents only, or both through review.

That's it. The hooks activate automatically on the next Copilot session.

## Notes

- **`.github/hooks/.runtime/` is git-ignored** — session records, `prime.txt`, and eval summaries are local to the current working tree. They do not persist across fresh checkouts (e.g. CI runs or coding agent sessions). Only `AGENTS.md` and `docs/` are durable across sessions.
- `prime.txt`, `last-session.md`, record JSON files, and `latest-eval.md` are generated from local runtime state and are not available after a fresh checkout.

## How the loop works

See [docs/hooks.md](docs/hooks.md) for the full sequence diagram and detailed hook design.

```
AGENTS.md + docs/     ← durable memory (committed)
prime.txt             ← session history (local, regenerated each session)
       ↓
  Copilot works
       ↓
hooks capture breadcrumbs → eval scores record → high-signal sessions trigger copilot -p
       ↓
AGENTS.md + docs/     ← updated with new learnings
```

## Eval loop

See [docs/eval.md](docs/eval.md) for the full scoring rubric and promotion flow.

You can also run the evaluator manually:

```bash
node .github/hooks/markdown-eval.mjs
node .github/hooks/markdown-eval.mjs --json
node .github/hooks/markdown-eval.mjs --record-outcomes
node .github/hooks/markdown-eval.mjs --limit 5
```

## What belongs where

See [docs/learning-guide.md](docs/learning-guide.md) for the full guide. Quick summary:

**AGENTS.md** — brief cross-cutting facts, build/test habits, architecture guardrails, short markdown links to `docs/`

**docs/** — hook design, eval details, per-subsystem conventions needing more depth

**Avoid everywhere** — temporary debugging notes, one-off task plans, stale checklists, session transcripts
