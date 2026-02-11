# Task 01 - Monorepo Bootstrap

## Goal
Initialize a Bun workspace with three apps and shared packages.

## In Scope
- Create workspace layout: `apps/desktop`, `apps/web`, `apps/sidecar`, `packages/shared`.
- Wire basic scripts for dev/build/typecheck.
- Ensure `apps/web` static export can be consumed by Tauri shell.

## Out of Scope
- Agent logic, permissions, search, updater.

## Deliverables
1. Workspace manifest and scripts.
2. Tauri app skeleton with Sidecar process hook.
3. Next.js + Tailwind + shadcn/ui base UI scaffold.

## Acceptance Criteria
1. `bun install` succeeds.
2. `bun run dev` starts desktop shell + web UI + sidecar.
3. `bun run build` produces desktop-buildable artifacts.

## Dependencies
- None.

## Completion Note
- Pending.

