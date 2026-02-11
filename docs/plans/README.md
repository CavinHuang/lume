# Lume V1 Task Breakdown

## Scope
This folder contains closed-loop implementation tasks for the V1 desktop agent app:
- `tauri + bun workspace + @anthropic-ai/claude-agent-sdk + nextjs + tailwind + shadcn/ui`

## Active Track (Fast MVP)
1. `docs/plans/00-fast-mvp-proma-migration.md`
2. Includes full Proma frontend interface migration to `apps/web`.

## Legacy Track (Full V1 Plan)
1. `docs/plans/01-monorepo-bootstrap.md`
2. `docs/plans/02-shared-contracts-and-schemas.md`
3. `docs/plans/03-sidecar-chat-core.md`
4. `docs/plans/04-desktop-ui-chat-mode.md`
5. `docs/plans/05-agent-tools-and-confirmation.md`
6. `docs/plans/06-workspace-and-whitelist.md`
7. `docs/plans/07-parallel-task-scheduler.md`
8. `docs/plans/08-web-search-provider-layer.md`
9. `docs/plans/09-secret-storage-encryption.md`
10. `docs/plans/10-updater-and-release-channel.md`
11. `docs/plans/11-test-matrix-and-quality-gates.md`
12. `docs/plans/12-v1-hardening-and-release.md`

## Track Rule
1. Execute `00-fast-mvp-proma-migration` first.
2. Legacy track items are resumed after Fast MVP stabilization gate.

## Closure Rule
Each task is considered closed only when:
1. Deliverables are merged.
2. Task-level acceptance criteria are fully met.
3. A short completion note is appended in the task file.
