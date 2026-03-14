# Copilot + Mulch instructions

Use the Mulch priming file prepared by the hook pack as part of your working context.

## At session start

1. Read `.github/hooks/.runtime/prime.txt` if it exists.
2. Treat that file as the current project memory exported from Mulch.

If the file is missing or stale, regenerate context with:

```bash
npx --no-install ml prime --exclude-domain copilot --format plain --export .github/hooks/.runtime/prime.txt
```

## When working on specific files

Refresh context for the files you are touching:

```bash
npx --no-install ml prime --exclude-domain copilot --files path/to/file.ts --format plain --export .github/hooks/.runtime/prime.txt
```

## Before finishing

1. Review `npx --no-install ml query copilot --sort-by-score`.
2. Promote durable learnings from the `copilot` inbox into real project domains with `ml record`.
3. Prefer foundational or tactical records only when they are reusable and grounded in the work you completed.
