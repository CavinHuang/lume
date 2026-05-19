# Lume Memory V2 Design

Date: 2026-05-18
Status: Spec review approved, awaiting user review

## Context

Lume needs a memory system that supports engineering continuity and personal collaboration preferences without becoming a black box. The current direction is a full redesign, not a migration of the existing memory implementation. There are no user data compatibility requirements for this design pass.

The design was shaped by:

- Alice v0.3.7 memory analysis: automatic background memory extraction, gatekeeping, smartAdd deduplication, and a small memory taxonomy.
- small-rust-hermes: Markdown plus YAML frontmatter entries, pinned memories, supersedes chains, project/user scopes, micro-reflection, and session-end reflection.
- MemPalace: local-first background capture, pre-compaction hooks, verbatim run archives, layered wake-up, hybrid retrieval, and explicit separation between original evidence and retrieval indexes.
- Community patterns from LangGraph, Letta/MemGPT, Mem0, Zep, and ChatGPT Memory: separate short-term and long-term memory, distinguish semantic/episodic/procedural knowledge, keep user control, and avoid making vector storage the only truth.

Lume should absorb the useful ideas, but not copy any system wholesale. It should be simpler than the current Lume memory model, more engineering-focused than Alice, lighter than MemPalace, and more automatic than Hermes.

## Goals

- Preserve engineering continuity across runs in the same workspace.
- Preserve stable user collaboration preferences across workspaces.
- Prefer automatic memory capture over confirmation-heavy workflows.
- Keep memory human-readable, editable, and auditable.
- Keep the user out of the loop for normal memory writes.
- Surface conflicts, stale memories, and low-confidence accumulation without interrupting work.
- Make Markdown and run archives the source of truth.
- Treat SQLite, FTS, and vector indexes as rebuildable caches.
- Keep the agent tool surface small and semantic.

## Non-Goals

- Migrating existing memory data.
- Building a full personal life memory product.
- Building a temporal knowledge graph in V1.
- Indexing every historical transcript and tool output by default.
- Enabling LLM rerank on every query by default.
- Coupling memory reflection with skill reflection.
- Cloud sync or telemetry.
- Exposing FTS, vector dimensions, chunk counts, and low-level index details in the main UI.

## Implementation Phases

The design describes the target shape, but implementation should be phased so Memory V2 does not become a large platform rewrite.

### V1 Contract

V1 must prove the core memory loop:

- Markdown-first `MEMORY.md`, `daily/YYYY-MM-dd.md`, and `entries/*.md`.
- Run archive append-only JSONL.
- YAML frontmatter schema and active/pending/archive status transitions.
- smartAdd classification for duplicate, conflict, stale, low-confidence, and new.
- Basic FTS/keyword/path search over `MEMORY.md`, entries, and recent daily files.
- Alice-style user message memory prefix with prefix stripping.
- `memory.context.used` event and bottom citation notice.
- Minimal settings surface for automatic memory, citation display, and pending counts.

### V1.1

V1.1 may add:

- Adaptive vector embeddings.
- Rule-based rerank tuning by intent.
- Deep archive search over run JSONL.
- Rich pending review UI.

### Later

Later work may add:

- Optional LLM rerank.
- More advanced relationship clustering.
- Rich diagnostics and index repair UI.

Temporal knowledge graphs, cloud sync, and skill reflection integration remain out of scope until separately designed.

## Architecture And Scope

Memory V2 has three scopes:

```text
Global User Memory
- Cross-workspace collaboration preferences.
- Examples: language preference, design-first workflow, automatic memory preference.

Workspace Memory
- Long-term engineering knowledge for one repo/project.
- Examples: architecture facts, decisions, project rules, lessons, current stage.

Run / Session Memory
- One run's raw process and short-term state.
- Examples: transcript, tool output, checked files, final summary, pre-compaction flush.
- Not a durable memory scope. It is evidence/archive material that may later produce Global or Workspace entries.
```

Long-term memory has five user-facing kinds:

```text
Preference  User or collaboration preference.
Fact        Stable project or user fact.
Decision    Design or implementation decision.
Lesson      Debugging lesson, pitfall, root cause, or working fix.
State       Current progress, open loop, next step, or rolling task state.
```

The memory system does not own reusable procedures. Skills, workflows, tool recipes, and automations belong to the skill system. Memory reflection and skill reflection may read the same run archive, but their outputs, UI, and lifecycle stay separate.

Durable memory entries only use `global` or `workspace` scope. `run` is a source/evidence boundary, not a long-term scope. A search request may ask for `scope: "run"` only to trigger deep archive search; results from that path are evidence snippets, not active memories.

## Storage Layout

Memory is Markdown-first. SQLite, FTS, and vector stores are indexes and caches.

```text
~/.lume/memory/
  MEMORY.md
  entries/
    2026-05-18-mem_xxx.md
  daily/
    2026-05-18.md
  pending/
    conflicts/
    stale/
    low-confidence/
  index/

<workspace>/.lume/memory/
  MEMORY.md
  entries/
    2026-05-18-mem_aaa.md
  daily/
    2026-05-18.md
  runs/
    run_<id>.jsonl
  pending/
    conflicts/
    stale/
    low-confidence/
  index/
```

### MEMORY.md

`MEMORY.md` is the human entry point. It contains core summary and pinned material, not every memory.

Global `MEMORY.md` contains cross-project collaboration preferences. Workspace `MEMORY.md` contains project core state, important rules, architecture landmarks, and selected pinned decisions.

### entries/*.md

`entries/*.md` stores long-term memory items. One file stores one claim. Each file has YAML frontmatter plus one short statement body.

```yaml
---
id: mem_20260518_abcd
kind: decision
scope: workspace
status: active
created: 2026-05-18T12:00:00Z
updated: 2026-05-18T12:00:00Z
source:
  type: run_completed
  run_id: run_123
  record_ids: [run_123:evt_00042]
  path: daily/2026-05-18.md
confidence: high
pinned: false
tags: [memory, architecture]
entities: [Lume]
related: []
supersedes: []
superseded_by: null
applies_when: {}
valid_from: null
valid_to: null
---
Lume memory uses Markdown as truth, while SQLite, FTS, and Vector are rebuildable indexes.
```

### daily/YYYY-MM-dd.md

Daily files are automatic work logs. They may be rough. They store run summaries, observations, obvious preferences, decisions, and candidates that were not promoted into entries.

Recent daily files are indexed by default for seven days.

### runs/run_<id>.jsonl

Run archives preserve original evidence: transcript, tool output, runtime events, memory flush payloads, and final run summaries. They are not part of normal recall. They are used for deep search, citations, stale/conflict review, and later re-extraction.

Run archives are local-only and privacy-sensitive. V1 must define these guardrails:

- A user instruction such as "do not remember this" or "不要记住这个" suppresses durable memory extraction for the current turn/run segment and records an exclusion marker instead of a memory candidate.
- By default, "do not remember this" suppresses durable extraction, not local transcript/archive persistence. If the user explicitly asks not to archive/log a segment, the archive writer should omit or redact that segment according to the privacy setting.
- Archive writers should redact obvious secrets before persistence, including API keys, tokens, private keys, authorization headers, and environment variable values that match secret-like names.
- Archive writers should preserve that redaction happened, but not the secret value.
- Users can delete a run archive. Deleting a run archive must not leave normal recall pointing at that archive as evidence.
- If a source entry points to a deleted/redacted archive record, the memory remains readable but its citation is marked unavailable.
- Workspace settings may disable run archive writing; when disabled, durable entries must still include non-sensitive source metadata when possible.
- The archive writer must respect existing project ignore boundaries for file-content capture and avoid storing ignored file bodies unless the user explicitly included them in the conversation.

V1 retention default is "keep until user deletes" because the archive is local and needed for audit. A later retention policy may add automatic pruning, but it must not silently delete evidence for active memories.

Run archive citations use a stable record id:

```json
{
  "id": "run_123:evt_00042",
  "type": "tool.result",
  "createdAt": "2026-05-18T12:00:00Z",
  "redacted": false
}
```

Memory entries cite archive records via `source.run_id` plus `source.record_ids`.

### pending/

Pending items are also Markdown so users can inspect and edit them.

- `pending/conflicts/`: candidates that conflict with active memory.
- `pending/stale/`: active memories whose applicability may have changed.
- `pending/low-confidence/`: potentially useful candidates below the confidence threshold.

Pending files use frontmatter too:

```yaml
---
id: pending_20260518_abcd
type: conflict
created: 2026-05-18T12:00:00Z
candidate:
  kind: preference
  targetScope: global
  statement: User prefers automatic memory without per-item confirmation.
existing:
  ids: [mem_20260510_old]
reason: "Candidate conflicts with existing confirmation preference."
evidence:
  run_id: run_123
  record_ids: [run_123:evt_00042]
status: open
---
```

Pending resolution edits this pending file status and creates/updates entry files as needed. Pending files are not normal recall sources.

Canonical mapping:

```text
entry status pending_conflict        <-> pending file type=conflict, status=open
entry status pending_low_confidence  <-> pending file type=low-confidence, status=open
entry status suspected_stale         <-> active/suspected entry plus pending file type=stale, status=open
```

The entry status controls recall. The pending file status controls review workflow.

### index/

`index/` may contain SQLite catalog, FTS tables, vector embeddings, and status metadata. It is disposable and rebuildable from Markdown and run JSONL.

Index metadata records the source hash and index status:

```json
{
  "schemaVersion": 1,
  "sourceHash": "sha256:...",
  "builtAt": "2026-05-18T12:00:00Z",
  "vectorStatus": "disabled|available|indexing|ready|stale|degraded"
}
```

## Memory Lifecycle

Memory moves through:

```text
Capture -> Extract -> Classify -> Commit -> Curate
```

### Capture

There are three trigger points.

```text
Micro-reflection
- Triggered by explicit memory or correction intent.
- Examples: "remember", "以后", "不对", "错了", "prefer", "actually".
- Captures only clear Preference, instruction-like preference, and correction signals.
- Runs in the background and does not block the next user turn.

Pre-compaction flush
- Triggered before context compaction.
- Saves run archive state and extracts State, Decision, Lesson, and open loops.
- Prevents important context from being lost during compaction.

Run completed reflection
- Main durable-memory extraction point.
- Reads the completed run, daily notes, and relevant current memories.
- Extracts Preference, Fact, Decision, Lesson, and State.
```

### Extract

Extractors produce candidates shaped like:

```ts
{
  kind: "preference" | "fact" | "decision" | "lesson" | "state",
  targetScope: "global" | "workspace",
  statement: string,
  confidence: "low" | "medium" | "high",
  evidence: {
    runId: string,
    sourceMessages?: string[],
    sourcePaths?: string[],
    quote?: string
  },
  tags: string[],
  entities: string[],
  appliesWhen?: Record<string, string>
}
```

Extraction rules:

- One candidate expresses one claim.
- Prefer false negatives over false positives.
- Every candidate must point to evidence.
- User-stated facts and agent-inferred facts must be distinguishable.
- Run evidence can support a global/workspace candidate, but the candidate itself cannot have durable `run` scope.
- V1 extraction uses an LLM when configured, with deterministic explicit-intent extraction as a non-blocking fallback.
- The recommended fast-model config is `memory.extraction.modelRef` in `lume.yaml`; `memory.extractionModelRef` is accepted as a compatibility shorthand.
- Extraction model failures must not block run completion.

### Classify

Candidates enter a smartAdd/relationship classifier.

```text
duplicate        -> skip
related          -> write active and attach weak related links
mergeable        -> pending/merge unless the merge only removes exact duplication
conflict         -> pending/conflict
suspected stale  -> mark old memory suspected_stale and create pending/stale review
low confidence   -> pending/low-confidence
new              -> active
```

### Commit

Writes follow these rules:

- Every run appends to `daily/YYYY-MM-dd.md`.
- Medium/high confidence candidates without conflict become active `entries/*.md`.
- Conflicts, low-confidence candidates, and stale reviews become pending Markdown.
- `MEMORY.md` is only updated for core, pinned, or summary material.

### Curate

Curation is user or background cleanup:

- Resolve conflicts: keep old, adopt new, merge edit, ignore new, archive both.
- Resolve stale items: archive, rewrite as historical, keep, or edit conditions.
- Periodically merge duplicates, update `MEMORY.md`, and rebuild indexes.

## Status Model

```text
active
- Normal recall.

archived
- User deleted, revoked, or archived it.
- Historical citations can still open it.
- Normal recall ignores it.

superseded
- Replaced by another entry.
- Normal recall ignores it.
- Audit views can show it.

pending_conflict
- Conflicts with active memory.
- Never participates in normal recall.
- Always surfaces as pending work.

pending_low_confidence
- Potentially useful, but not reliable enough.
- Never participates in normal recall.
- Reminds only after a threshold.

suspected_stale
- Not necessarily wrong, but applicability may have changed.
- Usually excluded from normal recall.
- Can appear as "Maybe Useful" with a stale warning when strongly relevant.
```

### Edit And Delete Transitions

Status transitions are explicit:

```text
edit active
  -> create a new active entry
  -> mark the old entry superseded
  -> set new.supersedes = [old.id]
  -> set old.superseded_by = new.id

delete / revoke / user archive
  -> mark entry archived
  -> keep file for audit and historical citations
  -> remove from normal recall

resolve conflict: adopt new
  -> create/adopt new active entry
  -> mark old entry superseded
  -> remove pending conflict file

resolve conflict: keep old
  -> keep old active
  -> archive or delete pending candidate

restore archived
  -> allowed only when the entry is not superseded by another active entry
  -> otherwise user must restore as a new active entry
```

`archived` means user intentionally removed a memory from active use. `superseded` means another entry replaced it.

## Conflict, Stale, And Related Memory

All conflicts go to pending. The system does not automatically overwrite active memory when a conflict is detected.

Conflicts include:

- New Preference contradicts old Preference.
- New Decision reverses old Decision.
- New Fact contradicts old Fact.
- New Lesson reverses a previous root cause or fix.

Stale detection handles condition changes rather than direct contradiction.

Example:

```text
Old: User's drive from Beijing home to office takes 15 minutes.
New: User recently moved to Tianjin.
Action: mark the old commute memory suspected_stale and create a pending stale review.
```

The user can archive it, rewrite it as historical, keep it, or edit conditions.

Related memory uses three relationship levels:

```text
supersedes
- Strong replacement. Affects active set.

related
- Weak explicit link. Helps detail pages and small rerank boosts.
- Does not affect active status.

dynamic cluster
- Derived at query time from tags, entities, sourceRunId, sourcePath, and kind.
- Avoids maintaining a complex graph.
```

## Retrieval And Rerank

Recall is layered.

```text
L0 Global Profile
- Global MEMORY.md plus pinned global entries.
- Small, always loaded.

L1 Workspace Core
- Workspace MEMORY.md plus pinned workspace entries.
- Loaded for main runs; summarized for subagents.

L2 Relevant Recall
- Global entries, workspace entries, and recent seven-day daily notes.
- Uses FTS, keyword, path matching, vector search when available, and rerank.

L3 Deep Archive Search
- Runs JSONL, historical daily files, and large tool output.
- On-demand only.
```

Vector strategy:

- FTS/keyword/path search is always available.
- Vector search is adaptive.
- Local embedding is used when available.
- External embedding is used only after explicit user configuration.
- Vector failures degrade silently to FTS for normal work.

Default indexed content:

- Global `MEMORY.md`.
- Global `entries/*.md`.
- Workspace `MEMORY.md`.
- Workspace `entries/*.md`.
- Workspace recent `daily/YYYY-MM-dd.md`, default seven days.

Default excluded content:

- Full run JSONL.
- Old daily files.
- Large tool outputs.

Rerank is rule-based by default:

```text
score =
  lexical/path score
+ vector score
+ pinned boost
+ scope boost
+ kind boost
+ recency boost
+ confidence boost
+ source quality boost
+ relation boost
- stale penalty
- conflict/pending exclusion
```

Weights shift by query intent:

```text
architecture/design  -> Decision + Fact + Lesson
continue task        -> State + recent daily
preference/correction -> Preference + pinned + global
debug                -> Lesson + exact error/path + recent daily
commit/workflow      -> Preference + workspace rules
```

LLM rerank is optional and only used for ambiguous queries, deep archive search, advanced semantic recall, or low-confidence rule rerank.

## Memory Injection

Lume should borrow Alice's user-message memory injection pattern, but keep the injected block smaller and query-scoped.

Instead of appending all memory to the system prompt, runtime builds a hidden memory prefix for the current user turn:

```text
<lume_memory_context>
  <global_preferences>
  - [mem_xxx] User prefers Chinese communication.
  </global_preferences>

  <workspace_core>
  - [mem_yyy] Lume memory uses Markdown as truth.
  </workspace_core>

  <relevant_recall>
  - [mem_zzz] Decision: Memory write is automatic by default.
  </relevant_recall>
</lume_memory_context>

<user_message>
actual user text
</user_message>
```

The UI continues to show only the actual user text. The model receives the prefixed content.

This has several benefits:

- It keeps memory attached to the user turn that triggered retrieval.
- It avoids growing the base system prompt with every recall result.
- It matches Alice's "memory update before user content" behavior.
- It makes memory injection easier to omit for subagents, group sessions, or privacy-sensitive modes.

The injected memory block has lower authority than the current user message, project instructions, AGENTS.md, runtime policy, tool policy, and system/developer instructions. Memory is background context only. It must never override a current user correction or a higher-priority instruction.

The prefix should include an explicit guardrail:

```text
These memories are background context. Follow current user instructions and project/runtime instructions if they conflict with memory. Treat suspected_stale items as possibly outdated.
```

The injected block is built from L0, L1, and L2 recall:

- Global pinned preferences.
- Workspace pinned/core memories.
- Reranked relevant recall.
- Strongly relevant suspected-stale memories only with explicit stale warnings.

The prefix must stay bounded. Default budget should be small and predictable:

```text
Global preferences: max 5
Workspace core: max 8
Relevant recall: max 6-10
Maybe stale: max 1-2
```

Runtime must strip this injected prefix before:

- writing run archives meant to represent user-visible transcript
- micro-reflection
- run-completed reflection
- memory extraction
- user-facing search over conversation text

This prevents self-contamination where the memory extractor re-saves injected memory as if the user had just said it. Alice explicitly strips injected prefixes before memory extraction; Lume should do the same with `<lume_memory_context>...</lume_memory_context>`.

The runtime should record the selected memory ids separately in a runtime event:

```ts
{
  type: "memory.context.used",
  runId: string,
  messageId: string,
  items: Array<{
    id: string,
    kind: "preference" | "fact" | "decision" | "lesson" | "state",
    scope: "global" | "workspace",
    status: "active" | "suspected_stale",
    citation: string,
    reason: string,
    score: number
  }>
}
```

The bottom memory citation UI should render from this event, not by parsing the injected message prefix.

## Agent Tools And Runtime APIs

The model-facing tool surface stays small.

### Default Agent Tools

Main agents get only:

```text
memory.search
memory.remember
```

`memory.search` searches memory without exposing FTS/vector/source internals.

```ts
{
  query: string,
  intent?: "architecture" | "debug" | "continue" | "preference" | "workflow" | "general",
  scope?: "auto" | "global" | "workspace" | "run",
  maxResults?: number
}
```

For `scope: "auto" | "global" | "workspace"`, it returns selected active/suspected-stale memories with citations and reasons:

```ts
{
  items: [
    {
      id: string,
      kind: "preference" | "fact" | "decision" | "lesson" | "state",
      scope: "global" | "workspace",
      status: "active" | "suspected_stale",
      statement: string,
      citation: string,
      reason: string,
      confidence: "low" | "medium" | "high"
    }
  ]
}
```

For `scope: "run"`, it performs deep archive search and returns evidence snippets instead of durable memory entries:

```ts
{
  evidence: [
    {
      id: string,
      runId: string,
      recordId: string,
      snippet: string,
      citation: string,
      reason: string
    }
  ]
}
```

The agent may use run evidence to answer the current question, but it does not become durable memory unless a later reflection or `memory.remember` produces a global/workspace candidate.

`memory.remember` is for explicit user intent or clear user correction/preference capture.

```ts
{
  statement: string,
  kind?: "preference" | "fact" | "decision" | "lesson" | "state",
  scope?: "auto" | "global" | "workspace",
  evidence?: string
}
```

`memory.remember` does not bypass smartAdd. It may create active memory, pending conflict, pending low-confidence, or stale review.

### Runtime Internal APIs

Lifecycle operations are runtime/service APIs, not ordinary agent tools:

```text
memory.captureMicro
memory.flushPreCompact
memory.reflectRunCompleted
memory.writeRunArchive
memory.rebuildIndex
```

The runtime owns capture timing, archive writing, reflection scheduling, and indexing.

### Maintenance And UI APIs

Settings and advanced operations use:

```text
memory.status
memory.read
memory.update
memory.archive
memory.restore
memory.resolvePending
memory.rebuildIndex
memory.deepSearchRuns
```

These are not default model-facing tools.

### Permission Boundaries

```text
main agent
- search
- remember

subagent
- workspace search by default
- no global writes by default
- no deep run search unless delegated by main agent/runtime

group/channel
- read workspace core only by default
- no durable writes by default

runtime
- capture, flush, reflect, archive, index
```

Do not expose these to normal agents by default:

```text
memory.writeEpisode
memory.distillWorkspace
memory.promoteGlobal
memory.rejectGlobalCandidate
memory.indexDocument
memory.indexWorkspace
memory.audit
memory.findConflicts
```

## UI And Settings

The UI should be visible but quiet.

### Bottom Memory Citation

Agent replies show a bottom lightweight memory notice by default. Users can turn it off.

Collapsed examples:

```text
Used 3 memories · 2 workspace · 1 global
Used 3 memories · 2 memory conflicts need review
Used 3 memories · 1 may be stale
```

Expanded items show:

- kind
- scope
- status
- confidence
- statement
- source path/citation
- reason for inclusion

Each item supports:

- open
- edit
- archive
- do not use in this workspace

### Settings Structure

Use four tabs:

```text
Overview
- Memory status
- Index status
- Pending counts
- Automatic memory toggle
- Bottom citation toggle

Workspace
- Workspace MEMORY.md
- Workspace entries
- Recent daily files
- Run deep search

Global
- Global MEMORY.md
- Pinned preferences
- Global entries

Pending
- Conflicts
- Suspected stale
- Low confidence
```

Primary settings:

```text
Automatic memory
[x] Run-completed memory reflection
[x] Pre-compaction context save
[x] Explicit preference/correction capture

Recall
[x] Use global collaboration preferences
[x] Use workspace memory
[x] Use recent seven-day daily notes
[x] Enable semantic recall when available

Display
[x] Show memories used below replies
[x] Show only memories that affected decisions
```

Defaults:

```text
automatic memory: on
global preferences: on
workspace memory: on
recent daily: on, seven days
semantic recall: auto
bottom citation: on
decision-affecting citations only: on
```

Reminder rules:

- Conflicts always show pending reminders.
- Stale pinned/Preference/Decision/State reminders show immediately.
- Ordinary stale Fact/Lesson reminders show after threshold, default five.
- Low-confidence reminders show after threshold, default five.

## Testing Boundaries

Storage tests:

- Write entry and read frontmatter/body.
- Edit creates new active entry and supersedes/archive chain for the old entry.
- Archived/superseded entries are excluded from active list.
- Daily appends by date.
- Run JSONL appends without rewriting previous records.
- Index can be deleted and rebuilt from Markdown.

Lifecycle tests:

- Explicit intent triggers micro capture.
- Pre-compaction triggers flush/archive.
- Run completed triggers reflection.
- Low-risk candidates become active.
- Conflicts become pending_conflict.
- Low-confidence candidates become pending_low_confidence.
- Condition changes create suspected_stale.

Retrieval/rerank tests:

- Pinned entries enter L0/L1.
- Active entries are retrievable.
- Pending, archived, and superseded entries are excluded from normal recall.
- Suspected stale appears only as warned Maybe Useful when strongly relevant.
- FTS works without vector.
- Vector failure degrades to FTS.
- Recent daily defaults to seven days.

UI tests:

- Bottom citation shows memory count.
- Setting disables bottom citation.
- Pending badge rules match thresholds.
- Edit/archive/restore update visible status.
- Open source resolves to Markdown path or run archive citation.

Failure handling tests:

- Reflection failure records a non-fatal runtime event and does not block the run.
- Malformed reflection JSON is ignored or repaired without writing partial entries.
- Injected `<lume_memory_context>` is stripped before run archive, micro-reflection, and run-completed reflection.
- Atomic Markdown writes do not leave half-written entries as active memory.
- Malformed frontmatter causes the file to be skipped with diagnostics rather than crashing recall.
- Corrupted run JSONL records are skipped while preserving later valid records.
- Concurrent writes to the same memory root serialize or retry without losing entries.
- Redaction removes obvious secrets before archive persistence.
- "Do not remember this" suppresses durable extraction for the relevant segment.

## Risks And Mitigations

```text
Risk: automatic memory pollutes future runs.
Mitigation: smartAdd, evidence requirements, pending conflicts, low-confidence threshold, soft archive, bottom citations.

Risk: Markdown and DB diverge.
Mitigation: Markdown is truth, DB is cache, hash-based stale detection, rebuild command.

Risk: vector provider instability harms recall.
Mitigation: FTS is always available, vector is adaptive, degraded state is non-fatal.

Risk: daily becomes a junk drawer.
Mitigation: only recent seven days are indexed by default, durable claims must be promoted to entries.

Risk: MEMORY.md becomes too large.
Mitigation: MEMORY.md only stores core/pinned/summary, not every entry.

Risk: pending reviews become noisy.
Mitigation: conflicts always remind, stale/low-confidence use kind-based thresholds.
```

## References

- Alice memory design analysis: `/Users/cavinhuang/Downloads/Alice深度分析/09-记忆系统设计.md`
- small-rust-hermes memory implementation: `/Users/cavinhuang/workspace/projects/ai-projects/small-rust-hermes`
- MemPalace repository: https://github.com/MemPalace/mempalace
- LangGraph memory docs: https://docs.langchain.com/oss/python/langgraph/memory
- Letta/MemGPT architecture: https://docs.letta.com/guides/agents/architectures/memgpt
- OpenAI Memory FAQ: https://help.openai.com/en/articles/8590148-memory-faq
