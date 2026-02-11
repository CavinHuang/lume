# Task 06 - Workspace and Whitelist

## Goal
Establish workspace concept and enforce whitelist-based file access.

## In Scope
- Add workspace CRUD and active workspace selection.
- Persist `root_paths` whitelist.
- Enforce path guard in all file-related tools.

## Out of Scope
- Concurrent task optimization.

## Deliverables
1. Workspace domain model and DB tables.
2. Guard middleware for out-of-scope path blocking.
3. UI for workspace management and path authorization.

## Acceptance Criteria
1. File access outside whitelist is blocked by default.
2. User can add/remove whitelist paths from UI.
3. All denials generate permission audit records.

## Dependencies
- `05-agent-tools-and-confirmation`.

## Completion Note
- Pending.

