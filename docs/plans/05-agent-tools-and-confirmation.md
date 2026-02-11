# Task 05 - Agent Tools and Confirmation

## Goal
Enable Agent mode with tool invocation and per-action confirmation.

## In Scope
- Add Agent execution pipeline in Sidecar.
- Implement tool abstraction (`read/write file`, `run command`) with risk levels.
- Add confirmation event flow and UI approval dialog.

## Out of Scope
- Workspace whitelist policy and cross-workspace path controls.

## Deliverables
1. Agent mode request path.
2. Tool call record persistence.
3. Confirmation UI for elevated actions.

## Acceptance Criteria
1. Agent mode can execute safe tools without breakage.
2. Elevated tool calls always pause and require explicit approval.
3. Approve/deny decision is auditable in DB.

## Dependencies
- `04-desktop-ui-chat-mode`.

## Completion Note
- Pending.

