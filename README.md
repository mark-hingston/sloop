# Copilot + [Mulch](https://github.com/jayminwest/mulch) self-learning hook pack

This folder is a minimal hook pack you can copy into an existing repository to add a [Mulch](https://github.com/jayminwest/mulch)-backed GitHub Copilot self-learning loop without modifying Mulch itself.

## What it does

- primes Mulch context at `sessionStart`
- captures prompt and tool breadcrumbs during the session
- records a tactical session summary into the `copilot` Mulch domain at `sessionEnd`

## Files

- `.github/hooks/mulch-copilot.json` - Copilot hook configuration
- `.github/hooks/mulch-self-learning.mjs` - hook runner
- `.github/hooks/mulch-eval.mjs` - asynchronous evaluator for `copilot` inbox records
- `AGENTS.md` - tells Copilot to read the repo-local Mulch prime file

## Bootstrap requirements

Before copying these files into a target repository, the user needs to:

1. Install [Mulch](https://github.com/jayminwest/mulch) in the target repo, for example with `npm install -D @os-eco/mulch-cli`.
2. Initialize Mulch with `./node_modules/.bin/ml init`.
3. Add a dedicated tactical inbox domain with `./node_modules/.bin/ml add copilot`.
4. Add any real project domains you want to learn into, such as `api`, `frontend`, or `testing`.
5. Ensure Node is available because the hook runner is executed with `node`.
6. Commit `.github/hooks/mulch-copilot.json` to the default branch so Copilot loads it.

After bootstrap, copy the three files in `.github/hooks/` plus `AGENTS.md` into the target repository.

## Notes

- The hook runner looks for Mulch at `./node_modules/.bin/ml` first, then falls back to `ml` or `mulch` on `PATH`.
- The `copilot` domain is used as an inbox for hook-generated session summaries.
- `sessionStart` exports primed context to `.github/hooks/.runtime/prime.txt`.
- To promote durable learnings, review `ml query copilot` and re-record stable insights into your real domains.
- `mulch-eval.mjs` is launched automatically in the background from `sessionEnd`, so it stays out of the synchronous hook path.

## How the loop works

1. `sessionStart` runs `ml prime --exclude-domain copilot --format plain --export .github/hooks/.runtime/prime.txt`
2. `userPromptSubmitted` logs the prompt to temp runtime state
3. `postToolUse` and `errorOccurred` log tool results and failures
4. `sessionEnd` runs `ml learn --json` and writes a session summary with `ml record copilot --stdin`
5. `sessionEnd` also background-spawns `mulch-eval.mjs --record-outcomes`
6. `mulch-eval.mjs` scores `copilot` records and appends `mulch-eval` outcomes asynchronously

## Eval loop

By default, the hook pack launches the evaluator in the background at `sessionEnd`. You can also run it manually or from CI:

```bash
node .github/hooks/mulch-eval.mjs
node .github/hooks/mulch-eval.mjs --json
node .github/hooks/mulch-eval.mjs --record-outcomes
```

The evaluator uses a deterministic rubric:

- groundedness: changed files and evidence
- reusability: domain mapping and breadth of touched files
- specificity: prompt/context richness
- validation signal: tool execution and existing session outcome data

Recommendations:

- `promote` - strong candidate to mine into real Mulch domains
- `review` - useful, but still tactical or incomplete
- `discard` - low-signal session summary

When `--record-outcomes` is used, the script appends a `mulch-eval` outcome to each unevaluated record using stock `ml outcome`.

The `copilot` domain acts as a tactical inbox for session summaries. It is excluded from priming so operational breadcrumbs do not get fed back into model context.

## Closing the loop

Hooks can prepare context, but they cannot directly inject it into Copilot's live prompt.

This pack closes the loop by combining:

- `sessionStart` hook: exports current Mulch context to `.github/hooks/.runtime/prime.txt`
- `AGENTS.md`: instructs Copilot to read that file at the beginning of a session and refresh it for file-scoped work
- `sessionEnd` hook: records new tactical learnings and launches async evaluation

That gives you a practical cycle of:

`Mulch domains -> prime.txt -> Copilot reads via AGENTS.md -> work happens -> hooks capture/evaluate -> humans/agents promote durable learnings back into Mulch`
