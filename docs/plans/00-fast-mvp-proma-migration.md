# Lume Fast MVP Plan (Proma -> Lume Direct Migration)

## Goal
Deliver a usable local-first desktop MVP as fast as possible by directly migrating proven Proma modules into Lume, with minimal adaptation.

## Strategy
1. Prefer direct migration over greenfield rewrite.
2. Keep runtime simple: file-based local storage first, database deferred.
3. Preserve Lume shell decisions (`Tauri + Next.js + Bun sidecar`), but borrow Proma service design and UI state model.
4. Ship one stable vertical slice first, then harden.

## MVP Scope
1. Chat mode end-to-end (streaming, history persistence, model/channel selection).
2. Agent mode end-to-end (single active task, workspace-scoped execution, tool activity stream).
3. Workspace CRUD with basic path guard.
4. Full Proma frontend interface migration (layout, views, settings, components, states, styles, assets).
5. No cloud dependency other than model provider APIs.

## Deferred (Not in Fast MVP)
1. SQLite schema and migration system.
2. Parallel scheduler and task lock manager.
3. Full permission confirmation state machine (`blocked_confirmation`).
4. Search provider layer (Tavily and fallback orchestration).
5. SecretStore abstraction (Argon2/libsodium + rotation).
6. Auto updater and release channel pipeline.
7. Full CI matrix and release hardening suite.

## Execution Phases

## Phase 0 - Repo Bootstrap
### Tasks
1. Initialize Bun workspace with `apps/desktop`, `apps/web`, `apps/sidecar`, `packages/shared`.
2. Add unified scripts: `dev`, `build`, `typecheck`.
3. Wire Tauri shell + Next export + sidecar process boot.

### Acceptance
1. `bun install` succeeds.
2. `bun run dev` starts desktop + web + sidecar.
3. `bun run build` completes without runtime stubs.

## Phase 1 - Shared Contracts Migration
### Tasks
1. Migrate and adapt Proma shared types into `packages/shared`.
2. Keep only MVP contract set:
   - channel
   - chat
   - agent
   - runtime
3. Define Lume IPC/event constants compatible with Tauri invoke/event bridge.
4. Port tool event conversion helpers (`tool-matching`) as shared pure logic.

### Source Mapping
1. `E:\projects\ai-projects\Proma\packages\shared\src\types\chat.ts` -> `packages/shared/src/chat.ts`
2. `E:\projects\ai-projects\Proma\packages\shared\src\types\agent.ts` -> `packages/shared/src/agent.ts`
3. `E:\projects\ai-projects\Proma\packages\shared\src\types\channel.ts` -> `packages/shared/src/channel.ts`
4. `E:\projects\ai-projects\Proma\packages\shared\src\types\runtime.ts` -> `packages/shared/src/runtime.ts`
5. `E:\projects\ai-projects\Proma\packages\shared\src\agent\tool-matching.ts` -> `packages/shared/src/agent/tool-matching.ts`

### Acceptance
1. Shared package builds and typechecks.
2. Sidecar and web both import shared contracts with no duplication.

## Phase 2 - Sidecar Service Migration (Core MVP)
### Tasks
1. Migrate provider adapter layer from Proma core into sidecar:
   - anthropic/openai/google adapters
   - SSE reader
2. Migrate file-based persistence services:
   - conversation manager (JSONL)
   - agent session manager (JSONL)
   - workspace manager
   - settings service
   - channel manager (local encrypted key strategy)
3. Migrate chat service orchestration and agent service orchestration.
4. Keep agent run mode to single in-flight task per session.
5. Add normalized path guard for workspace file operations.

### Source Mapping
1. `E:\projects\ai-projects\Proma\packages\core\src\providers\*` -> `apps/sidecar/src/providers/*`
2. `E:\projects\ai-projects\Proma\apps\electron\src\main\lib\conversation-manager.ts` -> `apps/sidecar/src/services/conversation-manager.ts`
3. `E:\projects\ai-projects\Proma\apps\electron\src\main\lib\chat-service.ts` -> `apps/sidecar/src/services/chat-service.ts`
4. `E:\projects\ai-projects\Proma\apps\electron\src\main\lib\agent-session-manager.ts` -> `apps/sidecar/src/services/agent-session-manager.ts`
5. `E:\projects\ai-projects\Proma\apps\electron\src\main\lib\agent-workspace-manager.ts` -> `apps/sidecar/src/services/agent-workspace-manager.ts`
6. `E:\projects\ai-projects\Proma\apps\electron\src\main\lib\agent-service.ts` -> `apps/sidecar/src/services/agent-service.ts`
7. `E:\projects\ai-projects\Proma\apps\electron\src\main\lib\settings-service.ts` -> `apps/sidecar/src/services/settings-service.ts`
8. `E:\projects\ai-projects\Proma\apps\electron\src\main\lib\channel-manager.ts` -> `apps/sidecar/src/services/channel-manager.ts`

### Adaptation Notes
1. Replace Electron APIs (`webContents`, `safeStorage`, dialogs) with sidecar-safe alternatives and Tauri command surfaces.
2. Keep encrypted key behavior minimal and local; exact SecretStore abstraction deferred.
3. Keep on-disk format versioned from day one for forward migration.

### Acceptance
1. Sidecar passes typecheck.
2. Sidecar can create/list sessions and stream model responses.
3. Restarting app preserves chat and agent history.

## Phase 3 - Tauri Bridge Migration
### Tasks
1. Recreate Proma IPC surfaces as Tauri commands/events.
2. Implement invoke handlers in desktop app and route to sidecar RPC.
3. Implement event fan-out:
   - chat stream chunk/reasoning/complete/error
   - agent stream event/complete/error/title updates

### Source Mapping
1. `E:\projects\ai-projects\Proma\apps\electron\src\main\ipc.ts` -> `apps/desktop/src-tauri/src/commands/*`
2. `E:\projects\ai-projects\Proma\apps\electron\src\preload\index.ts` -> `apps/web/src/lib/desktop-api.ts`

### Acceptance
1. Web app can invoke all MVP commands through desktop bridge.
2. Streaming events arrive in order and render without manual refresh.

## Phase 4 - Full Frontend Migration
### Tasks
1. Migrate full renderer state architecture (all atoms, not only chat/agent).
2. Migrate full app shell and navigation modules.
3. Migrate full chat module set.
4. Migrate full agent module set.
5. Migrate full settings module set.
6. Migrate file browser and AI element renderers.
7. Migrate shared UI primitives used by Proma frontend.
8. Migrate global styles and model/icon assets required by UI.
9. Adapt all Electron preload calls to Lume desktop API wrapper.

### Source Mapping
1. `E:\projects\ai-projects\Proma\apps\electron\src\renderer\atoms\*` -> `apps/web/src/atoms/*`
2. `E:\projects\ai-projects\Proma\apps\electron\src\renderer\components\app-shell\*` -> `apps/web/src/components/app-shell/*`
3. `E:\projects\ai-projects\Proma\apps\electron\src\renderer\components\chat\*` -> `apps/web/src/components/chat/*`
4. `E:\projects\ai-projects\Proma\apps\electron\src\renderer\components\agent\*` -> `apps/web/src/components/agent/*`
5. `E:\projects\ai-projects\Proma\apps\electron\src\renderer\components\settings\*` -> `apps/web/src/components/settings/*`
6. `E:\projects\ai-projects\Proma\apps\electron\src\renderer\components\file-browser\*` -> `apps/web/src/components/file-browser/*`
7. `E:\projects\ai-projects\Proma\apps\electron\src\renderer\components\ai-elements\*` -> `apps/web/src/components/ai-elements/*`
8. `E:\projects\ai-projects\Proma\apps\electron\src\renderer\components\ui\*` -> `apps/web/src/components/ui/*`
9. `E:\projects\ai-projects\Proma\apps\electron\src\renderer\styles\globals.css` -> `apps/web/src/styles/globals.css`
10. `E:\projects\ai-projects\Proma\apps\electron\src\renderer\assets\*` -> `apps/web/src/assets/*`
11. `E:\projects\ai-projects\Proma\apps\electron\src\renderer\App.tsx` -> `apps/web/src/App.tsx`
12. `E:\projects\ai-projects\Proma\apps\electron\src\renderer\main.tsx` -> `apps/web/src/main.tsx`

### Acceptance
1. Frontend module coverage reaches 100% against Proma renderer directories listed above.
2. Chat mode UI/behavior is parity-level usable.
3. Agent mode UI/behavior is parity-level usable.
4. Settings panel sections and forms are parity-level usable.
5. App shell navigation and mode switching are parity-level usable.
6. App restart restores mode/session state correctly.

## Phase 5 - Stabilization Gate (Before Feature Expansion)
### Tasks
1. Add smoke tests for:
   - create workspace
   - chat stream
   - agent run
   - restart restore
2. Add corruption-safe file IO guards and fallback recovery.
3. Add migration notes for future SQLite adoption.

### Acceptance
1. 20 cold-start manual runs without blocking failure.
2. No data loss across normal restart.
3. Recovery path documented for malformed JSON/JSONL.

## Direct Migration Task Board
1. `MIG-001`: bootstrap monorepo and runtime scripts.
2. `MIG-002`: import shared contracts and tool matching.
3. `MIG-003`: import provider adapters and SSE parser.
4. `MIG-004`: migrate chat persistence and streaming service.
5. `MIG-005`: migrate agent session/workspace services.
6. `MIG-006`: migrate agent streaming conversion pipeline.
7. `MIG-007`: implement Tauri invoke/event bridge.
8. `MIG-008`: migrate app-shell + navigation + mode switcher.
9. `MIG-009`: migrate full chat module + chat atoms.
10. `MIG-010`: migrate full agent module + agent atoms.
11. `MIG-011`: migrate full settings module + settings atoms.
12. `MIG-012`: migrate file-browser + ai-elements + ui primitives + global styles/assets.
13. `MIG-013`: workspace/file guard hardening.
14. `MIG-014`: smoke tests and restart consistency checks.
15. `MIG-015`: SQLite transition design doc (post-MVP gate).

## Risks and Blocking Points
1. Electron-specific APIs in Proma code need deterministic replacement.
2. SDK runtime paths and bundling differ between Electron and Tauri sidecar.
3. File storage concurrency can corrupt JSONL without write discipline.
4. Permission model mismatch can cause security regression if postponed too long.

## Definition of Done (Fast MVP)
1. User can complete full Chat flow and full Agent flow locally.
2. Workspaces and histories persist across restart.
3. Proma frontend renderer structure is fully migrated to Lume web app.
4. Streaming UX is stable.
5. Critical operations are logged and debuggable.
6. Deferred items are explicitly tracked, not silently dropped.
