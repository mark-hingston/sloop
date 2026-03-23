# Eval loop

The evaluator scores session records and recommends whether their learnings should be promoted to durable docs.

## Running manually

```bash
node .github/hooks/markdown-eval.mjs
node .github/hooks/markdown-eval.mjs --json
node .github/hooks/markdown-eval.mjs --record-outcomes
node .github/hooks/markdown-eval.mjs --limit 5
```

`--record-outcomes` appends eval outcomes to each record file and spawns a `copilot -p` promotion for any `promote`-rated session not yet promoted.

## Scoring rubric

Scores are deterministic and based on four dimensions (max 8):

| Dimension | Max | Signal |
|---|---|---|
| groundedness | 3 | changed files present (+2) and `evidence.file` set (+1) |
| reusability | 1 | two or more durable files changed (`AGENTS.md` or `docs/`) |
| specificity | 2 | prompt context captured (+1) and description ≥ 350 chars (+1) |
| validationSignal | 2 | Copilot outcome present (+1) and tool usage captured (+1) |

## Recommendations

| Score | Recommendation | Meaning |
|---|---|---|
| ≥ 7 | `promote` | Strong candidate — spawn promotion and update durable docs |
| ≥ 4 | `review` | Useful but still tactical or incomplete |
| < 4 | `discard` | Low-signal session; skip |

## Promotion

When a record scores `promote`, the evaluator spawns:

```bash
copilot -p "$(cat .github/hooks/prompts/promote-learnings.md)" --yolo --silent
```

The prompt template at `.github/hooks/prompts/promote-learnings.md` instructs the agent to update `AGENTS.md` and relevant `docs/` files with concise, reusable learnings.

A `markdown-promote` outcome is written to the record to prevent double-promotion.

## Outcome agents

Records accumulate outcomes from multiple agents over time:

| Agent | Meaning |
|---|---|
| `github-copilot` | Initial session outcome written by `sessionEnd` |
| `markdown-eval` | Scoring outcome appended by the evaluator |
| `markdown-promote` | Promotion outcome appended when `copilot -p` is spawned |
