# Lume SQLite Transition Design (Post-MVP)

## Goal
Define a safe migration path from current JSON/JSONL local storage to SQLite, without breaking existing user data or MVP behavior.

## Current Storage (File-based)
1. `~/.lume/channels.json`
2. `~/.lume/conversations.json`
3. `~/.lume/conversations/{conversationId}.jsonl`
4. `~/.lume/agent-workspaces.json`
5. `~/.lume/agent-sessions.json`
6. `~/.lume/agent-sessions/{sessionId}.jsonl`
7. `~/.lume/settings.json`

## Target SQLite Layout
Single DB file: `~/.lume/lume.db`

### Core Tables
1. `channels`
2. `channel_models`
3. `conversations`
4. `chat_messages`
5. `conversation_context_dividers`
6. `agent_workspaces`
7. `agent_sessions`
8. `agent_messages`
9. `settings_kv`
10. `schema_migrations`

### Key Constraints
1. Primary keys keep current string ids (UUID/slug based).
2. `chat_messages(conversation_id)` FK -> `conversations(id)`.
3. `agent_sessions(workspace_id)` FK -> `agent_workspaces(id)` nullable.
4. `agent_messages(session_id)` FK -> `agent_sessions(id)`.
5. Unique index on `agent_workspaces.slug`.

## Compatibility Strategy
1. Phase A (Dual-read, file-first):
   - keep file storage as source of truth.
   - SQLite writer runs in background for mirrored writes.
2. Phase B (Dual-read, db-first with file fallback):
   - read from SQLite first.
   - fallback to files only when db entry missing.
3. Phase C (DB-only):
   - stop file writes.
   - keep one-time export utility.

## One-time Import Plan
1. Add command `storage:migrate-to-sqlite`.
2. Migration steps:
   - create DB and schema
   - load channels + models
   - load conversations index + JSONL messages
   - load agent workspaces/sessions + JSONL messages
   - load settings
   - verify record counts
   - write migration marker in `schema_migrations`
3. Idempotency:
   - each table import uses upsert by primary key.
   - safe to rerun after interruption.

## JSONL Mapping Notes
1. Keep message content text as-is.
2. Store message extras (`reasoning`, `attachments`, `events`) in JSON columns.
3. Keep `createdAt/updatedAt` as integer milliseconds for parity.

## Failure & Recovery
1. Migration uses transaction batches (per domain) to avoid partial corruption.
2. On failure:
   - rollback current batch
   - keep file storage untouched
   - log failing item id for retry.
3. Provide `storage:verify` command for post-migration consistency check.

## Service Refactor Plan
1. Introduce `StorageAdapter` interface:
   - `FileStorageAdapter` (current)
   - `SqliteStorageAdapter` (new)
2. Chat/Agent/Settings services consume adapter instead of direct fs.
3. Runtime switch via config:
   - `storage.mode = file | hybrid | sqlite`

## Non-goals (for first SQLite cut)
1. Full-text search.
2. Multi-process lock manager.
3. Remote sync.

## Exit Criteria
1. Existing users migrate with no data loss.
2. Cold start and query latency better than file mode for large histories.
3. Restart consistency equivalent or better than current file mode.
