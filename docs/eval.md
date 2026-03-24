# Eval loop

The evaluator scores session records and recommends whether their learnings should be promoted to durable docs.

## Running manually

```bash
node .github/hooks/markdown-eval.mjs
node .github/hooks/markdown-eval.mjs --json
node .github/hooks/markdown-eval.mjs --record-outcomes
node .github/hooks/markdown-eval.mjs --semantic --record-outcomes
node .github/hooks/markdown-eval.mjs --limit 5
```

`--record-outcomes` appends eval outcomes to each record file and spawns a `copilot -p` promotion for any `promote`-rated session not yet promoted.

`--semantic` enriches un-scored records by calling the GitHub Models API (`gpt-4o-mini`) via `gh auth token`. Once scored, the result is stored in `record.metadata.semanticScore` so the LLM is only called once per record.

## Scoring rubric

Scores combine four deterministic dimensions with one optional LLM-scored dimension (max 11):

| Dimension | Max | Signal |
|---|---|---|
| groundedness | 3 | changed files present (+2) and `evidence.file` set (+1) |
| reusability | 2 | any durable file changed (+1) and `AGENTS.md` changed or 2+ durable files changed (+1) |
| specificity | 2 | prompt context captured (+1) and description ≥ 350 chars (+1) |
| validationSignal | 2 | Copilot outcome present (+1) and tool usage captured (+1) |
| semanticQuality | 2 | LLM-scored: actionability (+1) and gap detection (+1) |

`semanticQuality` defaults to 0 until `--semantic` is run. The LLM evaluates two sub-dimensions:
- **actionability**: would this guidance change how a future agent approaches similar work?
- **gap detection**: does this surface something missing or underspecified in current docs?

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

## Promotion verification

After spawning a promotion, the eval loop tracks the outcome as `pending`. On subsequent `--record-outcomes` runs, it checks `git log --since=<promotion_timestamp> -- AGENTS.md docs/` and flips the outcome to `success` if durable docs have changed. This closes the loop so silent no-op promotions are visible in the record.

## Outcome agents

Records accumulate outcomes from multiple agents over time:

| Agent | Meaning |
|---|---|
| `github-copilot` | Initial session outcome written by `sessionEnd` |
| `markdown-eval` | Scoring outcome appended by the evaluator |
| `markdown-promote` | Promotion outcome appended when `copilot -p` is spawned |
| `markdown-synthesise` | Appended to review-tier sessions included in a batch synthesis |

## Synthesis

When 3 or more `review`-tier sessions have accumulated without being synthesised, `--synthesise` batches them into a single `copilot -p` run using `.github/hooks/prompts/synthesise-learnings.md`. The prompt looks for **repeated patterns** across sessions — failures, workarounds, missing conventions — and writes only what appears more than once. Each included record gets a `markdown-synthesise: pending` outcome to prevent double-inclusion.

```bash
node .github/hooks/markdown-eval.mjs --synthesise --record-outcomes
```

## Improvement signal

Every eval run (no flag required) computes a score trend per durable file area. Records are grouped by their primary durable file (`AGENTS.md`, `docs/hooks.md`, etc.) and split into early vs recent thirds. Areas trending up by >8% are marked `improving ↑`; areas trending down are marked `declining ↓`. This appears in the `## Improvement signal` section of `latest-eval.md` and surfaces where current guidance is working — and where it isn't.
