# Task 10 - Updater and Release Channel

## Goal
Enable signed auto-update for macOS stable channel.

## In Scope
- Configure Tauri updater.
- Define update manifest generation process.
- Build signed artifact and channel metadata pipeline.

## Out of Scope
- Multi-channel rollout policy tuning.

## Deliverables
1. Updater config and UI entrypoint (check/download/apply).
2. Release script/pipeline documentation.
3. Rollback-safe failure behavior.

## Acceptance Criteria
1. App can detect available updates.
2. Signed package downloads and applies successfully.
3. Failed update keeps current version operational.

## Dependencies
- `09-secret-storage-encryption`.

## Completion Note
- Pending.

