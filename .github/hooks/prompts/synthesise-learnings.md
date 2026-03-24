Multiple Copilot sessions have been evaluated as worth reviewing but not individually promoted.
Your job is to find the **repeated patterns** across them and write only what is durable.

## Review sessions

{{reviewSessions}}

---

## Your task

### 1. Read first

Before writing anything:
- Read `AGENTS.md` to understand what top-level guidance already exists.
- List the files in `docs/` and read any that are relevant to the topics below.

### 2. Find patterns, not one-offs

Look across all sessions above for:
- **Repeated failures** — the same tool, command, or pattern failing more than once
- **Repeated workarounds** — the same fix applied across different sessions
- **Missing conventions** — something the agent had to rediscover each time
- **Implicit assumptions** — things that worked but were never written down
- **Repeated decisions with reasoning** — the same architectural or technology choice made across sessions, especially when reasoning was given. Capture as: `**[Choice]** — because [reason]`.
- **Superseded guidance** — cases where a newer session contradicts an older one. The newer guidance wins; remove or rewrite the stale content.

Ignore anything that appeared only once and is too narrow to generalise.

### 3. Decide where each pattern belongs

For each distinct pattern:

- **Update an existing `docs/` file** — if the pattern adds detail to a topic already covered there.
- **Create a new `docs/` file** — if the pattern covers a topic with enough depth to warrant its own file.
- **Add a short bullet to `AGENTS.md`** — if the pattern is a brief, cross-cutting fact that applies across the repo.
- **Add a markdown link in `AGENTS.md`** — whenever you write or update a `docs/` file, add or update a link in `AGENTS.md` pointing to it.

### 4. Write only what is new and durable

- Do not duplicate content already present in `AGENTS.md` or `docs/`.
- Do not add one-off plans, debugging breadcrumbs, speculative notes, or session transcripts.
- Remove or rewrite stale guidance rather than appending to it.
- Prefer short, specific bullets over paragraphs.
- When a pattern contradicts existing guidance in `AGENTS.md` or `docs/`, rewrite the stale guidance rather than appending. Note what was removed.
