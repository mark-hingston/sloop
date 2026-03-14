# Copilot self-learning template (markdown-first)

This branch shows a simpler self-learning pattern for GitHub Copilot: keep durable project guidance directly in `AGENTS.md` and update it over time as the repository evolves.

There is no Mulch dependency on this branch. The feedback loop lives in plain markdown that stays versioned with the repo.

This branch intentionally does not include hook scripts or an automated eval pipeline. The self-learning loop is the reviewable act of updating `AGENTS.md` with durable guidance.

## What it does

- gives Copilot a stable repo-local instruction file
- keeps conventions and durable learnings in one visible place
- lets humans or agents refine the shared memory by editing `AGENTS.md`

## Template files

- `AGENTS.md` - the repo-local instruction and memory file Copilot should read and maintain
- `README.md` - explains how to use the markdown-first approach

## Bootstrap requirements

Before copying these files into a target repository, the user needs to:

1. Commit `AGENTS.md` to the repository so Copilot can read it as repo-local guidance.
2. Seed `AGENTS.md` with the project's key conventions, workflows, and constraints.
3. Decide who is allowed to update it: humans only, agents only, or both through review.

After that, copy `README.md` and `AGENTS.md` into the target repository and adapt the sections to your project.

## How the loop works

1. Start with a concise `AGENTS.md` that explains the project and the rules Copilot should follow.
2. During work, treat `AGENTS.md` as the current durable memory for the repository.
3. When you discover a reusable fact, add it back to `AGENTS.md` in a stable, general form.
4. Periodically prune stale notes so the file stays short and high-signal.
5. Review `AGENTS.md` changes like any other source change before merging them.

That gives you a practical cycle of:

`repo guidance in AGENTS.md -> Copilot reads it -> work happens -> durable learnings get written back to AGENTS.md`

## What belongs in `AGENTS.md`

Good candidates:

- coding conventions that apply across the repo
- build, test, and release habits that are easy to forget
- architectural guardrails
- file- or subsystem-specific notes that will likely matter again

Avoid putting these in `AGENTS.md`:

- temporary debugging notes
- one-off task plans
- stale migrations or rollout checklists
- long transcripts of what happened in a single session

## Suggested maintenance pattern

- keep sections short and scannable
- prefer bullets over prose
- record facts, not speculation
- update or delete outdated guidance instead of endlessly appending

If you later need something more automated, you can still layer hooks or external tooling on top. This branch is intentionally the lightweight baseline: just `README.md`, `AGENTS.md`, and normal git review.
