# Lume External Memory Sources Design

Date: 2026-05-22
Status: Draft, awaiting user review

## Context

Lume Memory V2 already has a narrow "organize existing conversations" path: it scans user messages, asks the configured extraction model for memory candidates, then writes through `smartAddMemoryV2Candidate`. That path proves the right core loop, but it is still tied to conversation history as the only source.

OpenHuman's "Context in minutes, not weeks" idea combines two capabilities:

- External context acquisition: fetch content from documents, email, chats, or other sources.
- Memory organization: normalize, chunk, extract facts and relationships, then make them retrievable.

Lume should use the same product idea, but keep the implementation smaller: external documents are evidence sources, not a separate memory store. Markdown Memory V2 entries remain the source of truth.

## Goals

- Give users one obvious place to bring outside material into memory.
- Support existing conversations, workspace files, selected local files, and pasted text with one ingestion pipeline.
- Keep chat attachments temporary unless the user explicitly chooses to organize them as memory.
- Reuse Memory V2 extraction, claim writing, deduplication, conflict, and pending-review behavior.
- Avoid new databases, background sync systems, or connector frameworks in the first pass.
- Leave room for future connectors such as Notion, Google Drive, Gmail, Slack, or GitHub docs.

## Non-Goals

- Automatically remembering every uploaded attachment.
- Parsing every binary document format in the first version.
- Adding OAuth connectors in the first version.
- Introducing a second memory store, bridge layer, or wrapper around Memory V2.
- Making embedding required for external-source ingestion.
- Treating external documents as facts without LLM extraction and evidence tracking.

## Product Entry Points

### Primary Entry: Settings -> Memory -> External Sources

The main entry lives inside Memory Settings as an "External Sources" section.

It supports:

- Organize existing conversations.
- Organize workspace files.
- Import selected local files.
- Paste text and organize it.
- Review latest ingestion result: scanned sources, candidate count, new entries, duplicates, conflicts, low-confidence items.
- Open conflicts and pending items in the existing memory review UI.

This is the administrative control center. Users should be able to understand what entered memory and what was skipped.

### Quick Entry: Chat Attachments

Files attached to chat stay as conversation context by default. They do not become durable memory automatically.

Each attachment can expose a small action:

```text
Organize as memory
```

The action sends the file through the same external-source ingestion pipeline used by Memory Settings. This keeps the behavior predictable: "attach" means use now; "organize as memory" means remember later.

### Quick Entry: Workspace Resources

Workspace resource files can expose the same action:

```text
Organize as memory
```

This is useful for project docs, meeting notes, specs, PRDs, and architecture notes already saved into the workspace resource area.

## Architecture

The design introduces one generic ingestion shape and a small set of source collectors.

```ts
interface MemoryIngestionSource {
  id: string;
  kind: "history" | "workspace_file" | "local_file" | "pasted_text" | "connector";
  title: string;
  content: string;
  sourceRef: string;
  workspaceSlug: string;
  targetScope: "global" | "workspace";
  updatedAt?: number;
  metadata?: Record<string, string>;
}
```

Collectors only collect and normalize text. They do not write memory.

Initial collectors:

- `history`: existing thread user messages.
- `workspace_file`: text files from workspace resources.
- `local_file`: user-selected local text files.
- `pasted_text`: text pasted into the settings UI.

Future collectors:

- `connector`: Notion, Google Drive, Slack, Gmail, GitHub, or other external systems.

## Data Flow

```text
User chooses source
  -> source collector returns MemoryIngestionSource[]
  -> text is normalized and chunked
  -> extractMemoryCandidatesWithLlm runs on each chunk
  -> evidence is attached from sourceRef/title/chunk
  -> smartAddMemoryV2Candidate handles duplicate/conflict/stale/low confidence/new
  -> Markdown entries or pending files are written
  -> semantic index is marked stale when needed
  -> UI shows an ingestion report
```

The key boundary is that external sources never bypass `smartAddMemoryV2Candidate`. They are input evidence, not another memory path.

## Chunking

The first version should use deterministic, dependency-free text chunking:

- Keep paragraphs intact when possible.
- Target roughly 2,000 to 4,000 characters per chunk.
- Preserve source title and sourceRef on every chunk.
- Skip empty or extremely short chunks.
- Cap total processed characters per run to avoid surprise cost.

Binary document support can be added later through adapters that produce plain text or Markdown before this pipeline.

## Evidence

Every extracted candidate from an external source should include evidence:

- `sourcePaths`: sourceRef or path.
- `sourceMessages`: the source chunk or exact source text when safe.
- `recordIds`: stable source id plus chunk id.

For local files, `sourceRef` is the local file path. For pasted text, `sourceRef` can be a generated import id. For future connectors, `sourceRef` can be a URL or provider document id.

## Permissions And Safety

- No automatic external-source ingestion without an explicit user action in V1.
- Chat attachments stay temporary by default.
- Imported content should be scoped to the current workspace unless the user explicitly chooses global.
- Large imports should show an estimate before running when possible.
- Secrets redaction should reuse the same policy as run archive writing when available.
- Unsupported file types should fail with a clear UI message instead of attempting lossy parsing.

## UI Shape

Memory Settings gets an "External Sources" card.

Primary actions:

- `Organize conversations`
- `Organize workspace files`
- `Import files`
- `Paste text`

Status area:

- Last run time.
- Sources scanned.
- Chunks processed.
- Candidates found.
- New memories.
- Duplicates.
- Conflicts.
- Low-confidence pending items.

The UI should not expose implementation terms like embeddings, chunk ids, or internal candidate JSON in the main path.

## Agent Tools

Agent tools should come after the settings UI path is stable.

Candidate tools:

- `memory.organizeHistory`
- `memory.ingestSources`
- `memory.importText`

These tools must require explicit source inputs. The agent should not scan arbitrary external locations by itself.

## Implementation Phases

### Phase 1: Generic Ingestion Core

- Extract the current history organizer into a generic source ingestion service.
- Keep `organizeMemoryHistory` as a thin RPC use case only if needed by the UI, not as a second memory path.
- Add source result and ingestion report shared types.
- Add tests for duplicate, conflict, low-confidence, and source evidence preservation.

### Phase 2: Settings Entry

- Add the External Sources card to Memory Settings.
- Wire existing conversation organization through the generic ingestion core.
- Add pasted text import.
- Add workspace text file ingestion for supported extensions.

### Phase 3: Quick Actions

- Add "Organize as memory" for chat attachments.
- Add "Organize as memory" for workspace resource files.
- Reuse the same ingestion result UI summary.

### Later

- Add text extraction adapters for PDF/docx if a suitable existing runtime utility is available.
- Add connector ingestion after permissions, account linking, and sync semantics are separately designed.
- Add background refresh only after explicit source registration exists.

## Testing

- Existing conversation ingestion still writes through Memory V2 smart add.
- Pasted text import can create claim memories.
- Workspace file import preserves source file evidence.
- Duplicate source chunks do not repeatedly append identical claim entries.
- Conflicting claims go to pending conflict instead of overwriting active memory.
- Unsupported file types return a readable error.
- Chat attachment import does not run unless the user explicitly triggers it.

## Design Decision

The recommended first version is a generic ingestion core plus three user-controlled source paths: conversations, workspace text files, and pasted/local text. This gives Lume the OpenHuman-style "bring context in quickly" capability without copying OpenHuman's heavier SQLite tree, background job queue, or connector stack.
