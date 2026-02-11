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

## Execution Notes
1. 2026-02-11: `MIG-001` completed.
2. Verification:
   - `bun install` succeeded.
   - `bun run typecheck` succeeded (`shared`, `sidecar`, `web`).
   - `bun run build` succeeded (`shared`, `sidecar`, `web`, `desktop`).
3. 2026-02-11: `MIG-002` completed.
4. Verification:
   - Migrated shared contracts: `chat`, `agent`, `channel`, `runtime`.
   - Migrated shared helper: `agent/tool-matching`.
   - Added shared barrel exports (`src/types/index.ts`, `src/agent/index.ts`, `src/index.ts`).
   - `bun run typecheck` succeeded (`shared`, `sidecar`, `web`).
5. 2026-02-11: `MIG-003` completed.
6. Verification:
   - Migrated provider adapters to `apps/sidecar/src/providers/*`:
     - `anthropic-adapter`
     - `openai-adapter`
     - `google-adapter`
     - `types`
     - `sse-reader`
     - `url-utils`
     - `index`
   - Updated shared import scope `@proma/shared` -> `@lume/shared`.
   - Normalized local imports to extensionless paths for TS compatibility.
   - `bun run --filter @lume/sidecar build` succeeded.
   - `bun run typecheck` succeeded (`shared`, `sidecar`, `web`).
7. 2026-02-11: `MIG-004` completed.
8. Verification:
   - Added sidecar services:
     - `services/config-paths.ts`
     - `services/channel-manager.ts`
     - `services/conversation-manager.ts`
     - `services/chat-service.ts`
     - `services/attachment-service.ts`
     - `services/document-parser.ts`
   - Chat persistence and stream orchestration migrated to sidecar service layer.
   - `bun run --filter @lume/sidecar typecheck` succeeded.
   - `bun run --filter @lume/sidecar build` succeeded.
   - `bun run typecheck` succeeded (`shared`, `sidecar`, `web`).
9. 2026-02-11: `MIG-005` completed.
10. Verification:
   - Added sidecar services:
     - `services/agent-workspace-manager.ts`
     - `services/agent-session-manager.ts`
   - Expanded `services/config-paths.ts` with Agent/session/workspace/settings path helpers.
   - Migrated workspace capabilities support: MCP config read/write, Skills scan/frontmatter parse, plugin manifest creation, default workspace bootstrap.
   - `bun run --filter @lume/sidecar typecheck` succeeded.
   - `bun run --filter @lume/sidecar build` succeeded.
   - `bun run typecheck` succeeded (`shared`, `sidecar`, `web`).
11. 2026-02-11: `MIG-006` completed.
12. Verification:
   - Added agent stream conversion pipeline modules:
     - `services/agent-stream-converter.ts`
     - `services/agent-stream-accumulator.ts`
     - `services/agent-stream.ts`
   - Migrated pure `SDKMessage -> AgentEvent` conversion logic (tool/text/result/system/usage handling) from Proma `agent-service`.
   - Extracted assistant message accumulation/persistence payload builder for sidecar reuse.
   - `bun run --filter @lume/sidecar typecheck` succeeded.
   - `bun run --filter @lume/sidecar build` succeeded.
13. 2026-02-11: `MIG-007` foundation completed.
14. Verification:
   - Added Tauri bridge commands in desktop shell:
     - `sidecar_healthcheck`
     - `sidecar_call`
   - Desktop sidecar process now uses piped stdin/stdout for JSON-RPC request/response.
   - Added web bridge helpers in `apps/web/lib/desktop-api.ts`:
     - `sidecarHealthcheck()`
     - `sidecarCall()`
   - Updated sidecar boot log to stderr to avoid polluting RPC stdout stream.
   - `bun run typecheck` succeeded (`shared`, `sidecar`, `web`).
   - `bun run build` succeeded (`shared`, `sidecar`, `web`, `desktop`).
15. 2026-02-11: `MIG-007` bridge extended.
16. Verification:
   - Implemented sidecar JSON-RPC method router in `apps/sidecar/src/index.ts`:
     - Channel methods (`channel:*`)
     - Chat methods (`chat:*`) including stream notifications for `chat:send-message`
     - Agent session/workspace methods (`agent:*` subset except runtime send)
     - `rpc:list-methods`
   - Added sidecar notification protocol lines (`{ method, params }`) and desktop forwarding to Tauri event `sidecar:event`.
   - Added web listener helper `onSidecarEvent()` in `apps/web/lib/desktop-api.ts`.
   - Hardened sidecar stdout protocol: redirected `console.log` to stderr so stdout remains JSON-RPC only.
   - Runtime smoke test: piped JSON-RPC requests to sidecar process, verified valid JSON responses.
   - `bun run --filter @lume/sidecar typecheck` succeeded.
   - `cargo check` (desktop) succeeded.
17. 2026-02-11: `MIG-007` agent path enabled (fast MVP runtime).
18. Verification:
   - Added `apps/sidecar/src/services/agent-service.ts` with:
     - `sendAgentMessage` (provider-adapter streaming)
     - `stopAgent` / `stopAllAgents`
     - `generateAgentTitle`
   - Wired JSON-RPC handlers in `apps/sidecar/src/index.ts`:
     - `agent:send-message`
     - `agent:stop`
     - `agent:generate-title`
     - stream notifications: `agent:stream:event|complete|error` and `agent:title-updated`
   - Sidecar process smoke test:
     - request `agent:create-session`
     - request `agent:send-message` with missing channel
     - observed notification line `agent:stream:error` and final response `{ ok: true }`
   - `bun run typecheck` succeeded (`shared`, `sidecar`, `web`).
   - `bun run build` succeeded (`shared`, `sidecar`, `web`, `desktop`).
   - Note: current Agent runtime is fast-MVP provider stream mode (not full Claude Agent SDK orchestration yet).
19. 2026-02-11: `MIG-008` pre-migration bridge surface added.
20. Verification:
   - Expanded `apps/web/lib/desktop-api.ts` with Proma-style bridge wrappers:
     - Channel CRUD/test/models APIs
     - Chat CRUD/send/stream subscription APIs
     - Agent session/workspace/send/stream subscription APIs
   - Added generic sidecar method event filter helper `onSidecarMethodEvent`.
   - `bun run --filter @lume/web typecheck` succeeded.
   - `bun run --filter @lume/web build` succeeded.
21. 2026-02-11: `MIG-008` shell baseline implemented in web app.
22. Verification:
   - Added web shell state atoms:
     - `apps/web/atoms/app-mode.ts`
     - `apps/web/atoms/active-view.ts`
     - `apps/web/atoms/settings-tab.ts`
     - `apps/web/atoms/index.ts`
   - Added app-shell baseline components:
     - `apps/web/components/app-shell/AppShell.tsx`
     - `apps/web/components/app-shell/LeftSidebar.tsx`
     - `apps/web/components/app-shell/ModeSwitcher.tsx`
     - `apps/web/components/app-shell/MainContentPanel.tsx`
     - `apps/web/components/app-shell/index.ts`
   - Added placeholder feature views wired to desktop bridge:
     - `apps/web/components/chat/ChatView.tsx`
     - `apps/web/components/agent/AgentView.tsx`
     - `apps/web/components/settings/SettingsPanel.tsx`
   - Switched web entry from bootstrap page to App shell (`apps/web/App.tsx`, `apps/web/app/page.tsx`).
   - Reworked global styles for desktop-style shell layout (`apps/web/app/globals.css`).
   - Added web dependency: `jotai`.
   - `bun run typecheck` succeeded (`shared`, `sidecar`, `web`).
   - `bun run build` succeeded (`shared`, `sidecar`, `web`, `desktop`).
23. 2026-02-11: `MIG-009` initial chat/agent state wiring started.
24. Verification:
   - Added migrated state atoms:
     - `apps/web/atoms/chat-atoms.ts`
     - `apps/web/atoms/agent-atoms.ts`
   - Upgraded left sidebar to real data lists:
     - conversation list + create/select
     - agent session list + create/select + running indicator
   - Upgraded `ChatView` to real flow:
     - loads conversation messages
     - subscribes stream events (`chunk/reasoning/complete/error`)
     - sends/stops messages through sidecar bridge
     - picks default channel/model from channel list
   - Upgraded `AgentView` to real flow:
     - loads session messages
     - subscribes agent stream events/complete/error
     - sends/stops agent runs through sidecar bridge
   - Extended shell/theme CSS for list/message/form states.
   - `bun run typecheck` succeeded (`shared`, `sidecar`, `web`).
   - `bun run build` succeeded (`shared`, `sidecar`, `web`, `desktop`).
25. 2026-02-11: `MIG-009/010` component structure migration continued.
26. Verification:
   - Chat module split to Proma-style structure:
     - `components/chat/ChatHeader.tsx`
     - `components/chat/ChatMessages.tsx`
     - `components/chat/ChatInput.tsx`
     - `components/chat/ChatView.tsx` (container orchestration)
   - Agent module split to Proma-style structure:
     - `components/agent/AgentHeader.tsx`
     - `components/agent/AgentMessages.tsx`
     - `components/agent/AgentInput.tsx`
     - `components/agent/ToolActivityItem.tsx`
     - `components/agent/AgentView.tsx` (container orchestration)
   - Settings module advanced:
     - `components/settings/ChannelSettings.tsx` (list/create/delete/test)
     - placeholder sections: `GeneralSettings`, `AppearanceSettings`, `AgentSettings`, `AboutSettings`
     - `SettingsPanel.tsx` tab routing to real sections
   - Extended global stylesheet for split component structure and settings forms.
   - `bun run build` succeeded (`shared`, `sidecar`, `web`, `desktop`).
   - `bun run typecheck` succeeded (`shared`, `sidecar`, `web`).
   - Note: running `@lume/web typecheck` alone may intermittently fail before `.next/types` regeneration on Next 15; standard project pipeline remains passing.
27. 2026-02-11: `MIG-009/010` interaction depth increased.
28. Verification:
   - Sidebar now supports rename/delete for conversations and agent sessions.
   - Chat header now supports inline title editing.
   - Chat messages now support per-message delete and context divider render/remove.
   - Chat input added context boundary toggle action.
   - Agent tool activity model expanded (`intent`/`displayName`/`parentToolUseId`) and stream reducer updated.
   - Agent tool activity rendering upgraded to parent-child tree view.
   - Full workspace validation succeeded:
     - `bun run typecheck`
     - `bun run build`
29. 2026-02-11: `MIG-012` UI package extraction started (`Proma -> packages/ui`).
30. Verification:
   - Added new workspace package: `packages/ui` (source of truth for shared UI primitives).
   - Migrated Proma renderer UI primitives into `packages/ui/src/components/*`.
   - Added shared style utility: `packages/ui/src/lib/cn.ts`.
   - Added package export barrel: `packages/ui/src/index.ts`.
   - Wired workspace scripts to include `@lume/ui` in root `build/typecheck`.
   - Added `@lume/ui` as dependency of `apps/web`.
   - Validation passed:
     - `bun run --filter @lume/ui typecheck`
     - `bun run --filter @lume/ui build`
     - `bun run typecheck`
     - `bun run build`
31. 2026-02-11: `MIG-012` boundary correction applied (align with Proma package split).
32. Verification:
   - `packages/ui` now aligned to Proma `packages/ui` intent:
     - `src/code-block/*`
     - `src/hooks/*`
     - `src/mermaid-block/*`
     - `src/highlight/*` (localized from Proma core highlight for Lume compatibility)
   - `shadcn/ui` primitives moved to web-maintained location:
     - `apps/web/components/ui/*`
     - `apps/web/lib/utils.ts`
   - `apps/web` dependencies updated for local shadcn ownership (Radix/cva/cmdk/lucide/clsx/tailwind-merge).
   - Full validation passed after regeneration:
     - `bun run --filter @lume/ui typecheck`
     - `bun run typecheck`
     - `bun run build`
33. 2026-02-11: `MIG-012/013` file-browser data path enabled (sidecar + web).
34. Verification:
   - Added sidecar file service with session-root guard:
     - `apps/sidecar/src/services/agent-files-service.ts`
     - supports:
       - `agent:get-session-path`
       - `agent:list-directory`
       - `agent:delete-file`
       - `agent:save-files-to-session`
       - `agent:copy-folder-to-session`
   - Added web bridge wrappers:
     - `getAgentSessionPath`
     - `listAgentDirectory`
     - `deleteAgentFile`
     - `saveFilesToAgentSession`
     - `copyFolderToAgentSession`
   - Added File Browser module:
     - `apps/web/components/file-browser/FileBrowser.tsx`
     - `apps/web/components/file-browser/index.ts`
   - Integrated file browser into Agent view (workspace/session scoped root path).
   - Added shell styles for agent split layout and file tree interactions.
   - Validation passed:
     - `bun run typecheck`
     - `bun run build`
35. 2026-02-11: `MIG-012` ai-elements rendering baseline integrated.
36. Verification:
   - Added web ai-elements module:
     - `apps/web/components/ai-elements/message.tsx`
     - `apps/web/components/ai-elements/reasoning.tsx`
     - `apps/web/components/ai-elements/index.ts`
   - Chat and Agent message rendering now uses markdown pipeline:
     - `react-markdown + remark-gfm`
     - code fences render via `@lume/ui` `CodeBlock`
     - `mermaid` code fences render via `@lume/ui` `MermaidBlock`
   - Wired ai-elements into:
     - `apps/web/components/chat/ChatMessages.tsx`
     - `apps/web/components/agent/AgentMessages.tsx`
   - Added markdown/reasoning styles in `apps/web/app/globals.css`.
   - Validation passed:
     - `bun run typecheck`
     - `bun run build`
37. 2026-02-11: `MIG-011` settings module migration deepened.
38. Verification:
   - Added settings primitives module:
     - `apps/web/components/settings/primitives/*`
     - includes section/card/row/input/secret/select/toggle/segmented controls.
   - Migrated channel form flow:
     - added `apps/web/components/settings/ChannelForm.tsx`
     - upgraded `apps/web/components/settings/ChannelSettings.tsx` to list/create/edit view mode.
   - Migrated MCP form flow:
     - added `apps/web/components/settings/McpServerForm.tsx`
     - upgraded `apps/web/components/settings/AgentSettings.tsx` to manage MCP servers and skills list/delete.
   - Added sidecar/web API surfaces required by settings:
     - sidecar: `agent:delete-skill`
     - web bridge: `decryptChannelApiKey`, `listAgentWorkspaceSkills`, `deleteAgentWorkspaceSkill`
   - Extended global settings styles in `apps/web/app/globals.css`.
   - Validation passed:
     - `bun run typecheck`
     - `bun run build`
39. 2026-02-11: Proma Tailwind/shadcn engineering config synchronized to Lume web.
40. Verification:
   - Added web build tooling configs aligned with Proma:
     - `apps/web/tailwind.config.js`
     - `apps/web/postcss.config.js`
     - `apps/web/components.json`
   - Added Tailwind toolchain versions in `apps/web/package.json`:
     - `tailwindcss@^3.4.17`
     - `postcss@^8.4.49`
     - `autoprefixer@^10.4.20`
     - `@tailwindcss/typography@^0.5.19`
   - Updated `apps/web/app/globals.css`:
     - enabled `@tailwind base/components/utilities`
     - added shadcn-compatible CSS variable layer (`--background`, `--foreground`, etc.)
     - preserved existing Lume custom style variables using `--ui-border` to avoid token collision
   - Validation passed:
     - `bun run typecheck`
     - `bun run build`
41. 2026-02-11: `MIG-013/014` hardening and smoke automation added.
42. Verification:
   - Workspace/file guard hardening in sidecar path layer:
     - `apps/sidecar/src/services/config-paths.ts`
     - added strict segment validation for:
       - conversation ids
       - agent session ids
       - workspace slugs
     - added safe relative path validation for attachment resolution.
   - Added runnable RPC smoke script for restart consistency:
     - `apps/sidecar/scripts/smoke-rpc.mjs`
     - package script: `apps/sidecar/package.json` -> `smoke:rpc`
   - Smoke script covers:
     - create default workspace
     - create agent session
     - save/list session file
     - restart sidecar process
     - verify session/file persistence after restart
   - Validation passed:
     - `bun run --filter @lume/sidecar smoke:rpc` (output: `SMOKE_RPC_OK`)
     - `bun run typecheck`
     - `bun run build`
43. 2026-02-11: `MIG-015` SQLite transition design doc drafted.
44. Verification:
   - Added: `docs/plans/01-sqlite-transition-design.md`
   - Covers:
     - target schema and table mapping
     - staged compatibility strategy (file -> hybrid -> sqlite)
     - one-time idempotent importer
     - recovery/verification plan
     - service refactor via `StorageAdapter`
45. 2026-02-11: `MIG-012` renderer file-structure parity completed (component file coverage).
46. Verification:
   - Added missing Proma-mapped component files in `apps/web/components`:
     - `agent/AgentPlaceholder.tsx`
     - `agent/ContextUsageBadge.tsx`
     - `agent/WorkspaceSelector.tsx`
     - `ai-elements/context-divider.tsx`
     - `ai-elements/conversation.tsx`
     - `ai-elements/rich-text-input.tsx`
     - `ai-elements/speech-button.tsx`
     - `app-shell/NavigatorPanel.tsx`
     - `app-shell/Panel.tsx`
     - `app-shell/PanelHeader.tsx`
     - `chat/AttachmentPreviewItem.tsx`
     - `chat/ChatMessageItem.tsx`
     - `chat/ClearContextButton.tsx`
     - `chat/ContextSettingsPopover.tsx`
     - `chat/CopyButton.tsx`
     - `chat/DeleteMessageDialog.tsx`
     - `chat/ModelSelector.tsx`
     - `chat/ParallelChatMessages.tsx`
     - `chat/UserAvatar.tsx`
   - Updated module export barrels:
     - `apps/web/components/chat/index.ts`
     - `apps/web/components/agent/index.ts`
     - `apps/web/components/app-shell/index.ts`
     - `apps/web/components/ai-elements/index.ts`
   - Parity check result:
     - missing files against Proma renderer `components/*`: `0`
   - Validation passed:
     - `bun run typecheck`
     - `bun run build`
47. 2026-02-11: settings atom/about polish continued for Proma parity baseline.
48. Verification:
   - Added atom surface:
     - `apps/web/atoms/updater.ts`
     - exported via `apps/web/atoms/index.ts`
   - Added lightweight local profile/theme atom persistence:
     - `apps/web/atoms/user-profile.ts`
     - `apps/web/atoms/theme.ts`
   - Upgraded `apps/web/components/settings/AboutSettings.tsx` from placeholder to runtime-aware panel.
   - Validation passed:
     - `bun run typecheck`
     - `bun run build`
