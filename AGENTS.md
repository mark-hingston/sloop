# Copilot markdown-first instructions

Use this file as the repository's durable shared memory.

## At session start

1. Read this file in full.
2. Read `.github/hooks/.runtime/prime.txt` if it exists.
3. Treat this file as the source of truth for durable repo guidance, and treat `prime.txt` as hook-generated session context built from it.

## While working

1. Follow the guidance in this file unless the user explicitly overrides it.
2. When you discover a durable fact that will help in future sessions, update this file instead of storing the note in an external tool.
3. Prefer concise, reusable bullets over long narrative notes.
4. Treat `.github/hooks/.runtime/last-session.md` and `.github/hooks/.runtime/latest-eval.md` as local tactical artifacts, not durable memory.

## Before finishing

1. Add or refine only durable guidance that is grounded in the work you completed.
2. Remove or rewrite stale instructions so this file stays high-signal.
3. Avoid recording one-off plans, temporary debugging breadcrumbs, or speculative notes.
4. Review local eval output when it helps decide what belongs in this file.

## Suggested sections

- Project overview
- Build and test workflow
- Coding conventions
- Architecture guardrails
- Durable learnings by area

## Durable learnings

- Keep entries short, specific, and reusable.
- When possible, point at the relevant file or subsystem.
