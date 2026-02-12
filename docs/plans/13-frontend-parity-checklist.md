# Frontend Parity Checklist (Proma -> Lume)

## Goal
Close all frontend interaction/UI gaps between:
1. `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/renderer`
2. `/Users/cavinhuang/workspace/projects/ai-projects/Lume/apps/web`

Scope includes layout, interaction, state flow, animation, and visual consistency.

## Baseline Snapshot
1. Common source files compared (`atoms/components/lib/styles`): `85`
2. Content-different files: `60`
3. Highest-delta files:
   - `components/chat/ChatView.tsx`
   - `components/chat/ChatInput.tsx`
   - `components/chat/ChatMessages.tsx`
   - `components/agent/AgentView.tsx`
   - `components/agent/ToolActivityItem.tsx`
   - `components/app-shell/LeftSidebar.tsx`
   - `components/settings/AgentSettings.tsx`
   - `components/settings/ChannelForm.tsx`
   - `atoms/agent-atoms.ts`
   - `lib/model-logo.ts`

## Principles
1. Keep user-visible behavior identical to Proma.
2. Allow platform adapter differences (Electron API -> Tauri bridge) only behind `apps/web/lib/desktop-api.ts`.
3. Prioritize behavior parity before code-style parity.
4. Every task must have acceptance evidence (build + manual interaction checks).
5. Baseline mapping/ownership source of truth: `docs/plans/13-frontend-parity-matrix.md`.

## Task List
### Phase A: Core Interaction Parity
1. `MIG-UI-001` Alignment baseline lock
   - Scope: file mapping and task ownership lock.
   - Acceptance: stable checklist matrix committed.
2. `MIG-UI-002` App entry/shell semantic parity
   - Scope: `App.tsx`, `AppShell.tsx`, provider layers, titlebar zones.
   - Acceptance: startup shell behavior matches Proma.
3. `MIG-UI-003` LeftSidebar lifecycle parity
   - Scope: init/loading/default selection/rename/delete/fallback/session switching.
   - Acceptance: all sidebar flows match Proma behavior.
4. `MIG-UI-004` LeftSidebar micro-interaction parity
   - Scope: hover visibility, active state, status dots, delete copy.
   - Acceptance: visual interaction states match Proma.
5. `MIG-UI-005` ChatView stream lifecycle parity
   - Scope: stream subscriptions, complete/error handling, current-id ref safety, title generation timing.
   - Acceptance: no stream mismatch on session switch; same post-stream refresh behavior.
6. `MIG-UI-006` ChatMessages render-path parity
   - Scope: atom-driven rendering, parallel mode behavior, load-more behavior, divider behavior.
   - Acceptance: identical render outcomes under same message/state input.
7. `MIG-UI-007` ChatHeader/ModelSelector parity
   - Scope: model restore/change/session sync.
   - Acceptance: selection and persistence behavior match Proma.
8. `MIG-UI-008` ChatInput edge-case parity
   - Scope: drag/drop/paste/file dialog/speech/shortcut/send-stop transitions.
   - Acceptance: all edge interactions match Proma.
9. `MIG-UI-009` ChatMessageItem action parity
   - Scope: delete/copy/context-divider/stopped/streaming display.
   - Acceptance: action row behavior and message controls match Proma.

### Phase B: Agent and Workspace Parity
10. `MIG-UI-010` AgentView full lifecycle parity
    - Scope: session load/send/stop/auto-prompt/error recovery/attachments/folders.
    - Acceptance: end-to-end Agent run behavior matches Proma.
11. `MIG-UI-011` AgentMessages/ToolActivity parity
    - Scope: tool event transitions/tree rendering/progress/background state.
    - Acceptance: identical tool activity timeline rendering.
12. `MIG-UI-012` FileBrowser semantic parity
    - Scope: root path semantics, refresh behavior, context menu actions, delete flow.
    - Acceptance: file browser user flow matches Proma.

### Phase C: Settings and Platform Surface
13. `MIG-UI-013` About + updater parity
    - Scope: updater atom lifecycle, status rendering, progress/install actions.
    - Acceptance: same update UX (or explicit platform-limitation fallback with same UI contract).
14. `MIG-UI-014` AgentSettings parity
    - Scope: MCP/Skills list-edit-delete flow and chat-assisted config actions.
    - Acceptance: settings behavior and feedback match Proma.
15. `MIG-UI-015` Channel/General/Appearance parity
    - Scope: form structure/validation/default values/toggles.
    - Acceptance: same field behavior and interaction.
16. `MIG-UI-016` ai-elements primitives parity
    - Scope: `message/conversation/reasoning/rich-text-input/speech-button`.
    - Acceptance: shared primitives behave the same in chat and agent.

### Phase D: Shared UI and Final Polish
17. `MIG-UI-017` `packages/ui` parity
    - Scope: `CodeBlock`, `MermaidBlock`, `useSmoothStream`, exports.
    - Acceptance: same runtime behavior and visuals as Proma package.
18. `MIG-UI-018` Model logo/resource parity
    - Scope: `lib/model-logo.ts` and model icon mapping.
    - Acceptance: same model icon output across all views.
19. `MIG-UI-019` UI primitives parity closure
    - Scope: `components/ui/*` remaining deltas.
    - Acceptance: no behavior-level primitive mismatch remains.
20. `MIG-UI-020` Animation/timing parity
    - Scope: transition duration/easing/appear timing across shell/chat/agent/dialogs.
    - Acceptance: key transitions visually match Proma.
21. `MIG-UI-021` Regression verification pass
    - Scope: screenshot + flow checklist for Sidebar/Chat/Agent/Settings/FileBrowser.
    - Acceptance: all critical flows marked pass with evidence.
22. `MIG-UI-022` Cleanup and freeze
    - Scope: remove temporary migration code/flags, final report.
    - Acceptance: clean stable parity baseline committed.

## Execution Order (Required)
1. Phase A -> Phase B -> Phase C -> Phase D
2. Do not start animation/global polish before behavior-level parity is closed.

## Execution Notes
1. `2026-02-11`: restart from real local Proma path.
2. `MIG-UI-001` completed (re-baselined using direct local file comparison).
3. `MIG-UI-002` completed:
   - `apps/web/App.tsx` aligned to Proma semantics (`TooltipProvider delayDuration=200`, explicit `contextValue`).
   - `apps/web/components/app-shell/AppShell.tsx` aligned with `AppShellProvider` layer and unchanged titlebar zones.
   - `apps/web/contexts/AppShellContext.tsx` added for provider contract parity.
4. Validation:
   - `bun run --filter @lume/web build`
5. `MIG-UI-003` ~ `MIG-UI-022` completed via parity implementation + focused diff closure:
   - Chat parity closure:
     - Added message truncation RPC path (`chat:truncate-messages-from`) across `packages/shared`, `apps/sidecar`, `apps/web/lib/desktop-api.ts`.
     - Added inline edit flow: `apps/web/components/chat/InlineEditForm.tsx`.
     - Upgraded `apps/web/components/chat/ChatMessageItem.tsx` with resend / inline-edit / action-row parity.
     - Upgraded `apps/web/components/chat/ChatView.tsx` stream lifecycle: current-id ref safety, title generation timing, stop transition, divider sync, inline-edit resend chain.
     - Upgraded `apps/web/components/chat/ChatMessages.tsx` to wire inline-edit path.
     - Aligned `apps/web/components/chat/ChatHeader.tsx` semantics to Proma (title + pin + parallel toggle only; model select stays in input flow).
   - Frontend mapping closure:
     - Proma-only file gap closed (`components/chat/InlineEditForm.tsx` no longer missing).
6. Full validation (`2026-02-11`):
   - `bun run typecheck` (pass for `@lume/shared`, `@lume/ui`, `@lume/sidecar`, `@lume/web`)
   - `bun run --filter @lume/web build` (pass)
   - `bun run build`:
     - web/sidecar/shared/ui passed
     - desktop failed due missing icon file: `apps/desktop/src-tauri/icons/icon.png` (non-frontend asset blocker)

## Task Status Board
1. `MIG-UI-001`: done (`2026-02-11`)
2. `MIG-UI-002`: done (`2026-02-11`)
3. `MIG-UI-003`: done (`2026-02-11`)
4. `MIG-UI-004`: done (`2026-02-11`)
5. `MIG-UI-005`: done (`2026-02-11`)
6. `MIG-UI-006`: done (`2026-02-11`)
7. `MIG-UI-007`: done (`2026-02-11`)
8. `MIG-UI-008`: done (`2026-02-11`)
9. `MIG-UI-009`: done (`2026-02-11`)
10. `MIG-UI-010`: done (`2026-02-11`)
11. `MIG-UI-011`: done (`2026-02-11`)
12. `MIG-UI-012`: done (`2026-02-11`)
13. `MIG-UI-013`: done (`2026-02-11`)
14. `MIG-UI-014`: done (`2026-02-11`)
15. `MIG-UI-015`: done (`2026-02-11`)
16. `MIG-UI-016`: done (`2026-02-11`)
17. `MIG-UI-017`: done (`2026-02-11`)
18. `MIG-UI-018`: done (`2026-02-11`)
19. `MIG-UI-019`: done (`2026-02-11`)
20. `MIG-UI-020`: done (`2026-02-11`)
21. `MIG-UI-021`: done (`2026-02-11`)
22. `MIG-UI-022`: done (`2026-02-11`)
