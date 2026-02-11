# Task 02 - Shared Contracts and Schemas

## Goal
Define stable cross-process contracts between UI, Tauri, and Sidecar.

## In Scope
- Add shared types and Zod schemas in `packages/shared`.
- Define command/event payloads for session/message/task/workspace/settings.
- Define error codes and task status enum.

## Out of Scope
- Concrete tool execution or DB persistence details.

## Deliverables
1. Typed command/event interfaces.
2. Runtime validation schemas.
3. Error model and serialization helpers.

## Acceptance Criteria
1. All IPC payloads validate with schemas.
2. Typecheck passes in all apps with shared package imports.
3. Invalid payloads return structured error (`code`, `message`, `details`).

## Dependencies
- `01-monorepo-bootstrap`.

## Completion Note
- Pending.

