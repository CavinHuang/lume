# Task 03 - Sidecar Chat Core

## Goal
Deliver Chat mode end-to-end with Claude streaming via Sidecar.

## In Scope
- Implement Sidecar RPC for session create/send message.
- Integrate `@anthropic-ai/claude-agent-sdk` for streaming response.
- Persist sessions/messages in SQLite.

## Out of Scope
- Tool calling, permission confirmation, web search.

## Deliverables
1. Sidecar chat service with stream events.
2. SQLite tables for sessions and messages.
3. Tauri bridge wiring for chat commands/events.

## Acceptance Criteria
1. User can create a session and get streaming replies.
2. Restarting app preserves chat history.
3. Failed model calls return user-visible structured errors.

## Dependencies
- `02-shared-contracts-and-schemas`.

## Completion Note
- Pending.

