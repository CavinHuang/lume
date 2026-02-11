# Task 07 - Parallel Task Scheduler

## Goal
Support multiple concurrent Agent tasks with safe coordination.

## In Scope
- Implement task state machine and queue manager.
- Add configurable concurrency limit (default `2`).
- Add write-lock strategy per workspace for conflicting tool writes.
- Add task cancel path.

## Out of Scope
- Web search provider integration.

## Deliverables
1. Scheduler module in Sidecar.
2. Task events (`queued/running/blocked/completed/failed/cancelled`).
3. UI task list and status chips.

## Acceptance Criteria
1. Two tasks can run in parallel without process crash.
2. Conflicting write actions are serialized by lock.
3. Cancel requests stop further tool calls for target task.

## Dependencies
- `06-workspace-and-whitelist`.

## Completion Note
- Pending.

