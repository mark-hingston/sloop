A Copilot session has been evaluated as worth promoting to durable knowledge.

Session details:
- Prompts: {{prompts}}
- Changed files: {{changedFiles}}
- Tool outcomes: {{toolOutcomes}}
- Knowledge types: {{knowledgeTypes}}

## Your task

Promote durable learnings from this session into the project's memory files. Follow these steps in order.

### 1. Read first

Before writing anything:
- Read `AGENTS.md` to understand what top-level guidance already exists.
- List the files in `docs/` and read any that are relevant to this session's topics.

### 2. Decide where each learning belongs

For each distinct learning from the session, decide:

- **Update an existing `docs/` file** — if the learning adds detail to a topic already covered there.
- **Create a new `docs/` file** — if the learning covers a topic with enough depth to warrant its own file (more than a few bullets).
- **Add a short bullet to `AGENTS.md`** — if the learning is a brief, cross-cutting fact that applies across the repo.
- **Add a markdown link in `AGENTS.md`** — whenever you write or update a `docs/` file, add or update a link in `AGENTS.md` pointing to it (e.g. `See [topic](docs/topic.md)`). Do not expand the detail inline in `AGENTS.md`.

### 3. Handle superseding content

When updating or replacing existing guidance:

- **Remove the stale content** — do not append to contradictory guidance; rewrite it. Note briefly what you removed.
- If you substantially change a bullet or section, add a brief inline note: *(supersedes: [old guidance summary])*

### 4. Write only what is new and durable

- Do not duplicate content already present in `AGENTS.md` or `docs/`.
- Do not add one-off plans, debugging breadcrumbs, speculative notes, or session transcripts.
- Keep `AGENTS.md` entries short and specific.
- Remove or rewrite stale guidance rather than appending to it.
- For architectural or technology decisions, capture the reasoning: write decisions as `**[Choice]** — because [reason]` or `**[Choice]** — after evaluating [alternatives]`.
- Look for reasoning patterns in the session prompts: phrases like *"because"*, *"due to"*, *"after evaluating"*, *"since"*, *"instead of"*.
