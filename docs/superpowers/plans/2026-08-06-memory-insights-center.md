# Lume 记忆与洞察中心 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (\`- [ ]\`) syntax for tracking.

**Goal:** 将主动中心与设置记忆页收敛为唯一的“记忆与洞察”日常入口，并把设置中的记忆页缩减为高级配置与诊断。

**Architecture:** 保留现有 \`proactive\` tab 类型和 \`__proactive__\` ID，仅替换用户可见名称。新中心复用 \`MemorySettingsSnapshot\`、MutationReceipt 和现有记忆 RPC，内部拆成“需要处理、记忆、洞察、活动”四个 section；高级设置新增轻量诊断投影，避免加载原子记忆列表。运行时事件通过一个全局版本 atom 驱动中心刷新，任务轮询只作为恢复兜底。

**Tech Stack:** React/TSX、Jotai、Bun、Electron sidecar RPC、\`@lume/shared\` 类型、现有 shadcn UI 原子组件。

**实施状态（2026-08-08）：** 代码、定向测试、类型检查与 PR 提交均已完成；桌面开发版已成功启动，但自动化控制无法激活 Electron 主窗口，因此只保留桌面交互 smoke 为人工复核项。

---

## 文件地图

- \`packages/shared/src/types/memory.ts\`：MemoryDiagnosticsSnapshot 类型和 diagnostics IPC channel。
- \`apps/sidecar/src/services/memory-v2/settings-snapshot.ts\`：完整中心 Snapshot 与轻量诊断 Snapshot 的派生逻辑。
- \`apps/sidecar/src/rpc/memory-handlers.ts\`：diagnostics RPC handler。
- \`apps/web/src/lib/desktop-api/memory.ts\`：诊断 Snapshot 客户端方法。
- \`apps/web/src/atoms/memory-center-atoms.ts\`：中心 section、深链和刷新版本状态。
- \`apps/web/src/components/memory/memory-center-state.ts\`：section/deep-link 类型、过滤器和默认导航的纯函数。
- \`apps/web/src/components/memory/use-memory-center.ts\`：中心数据加载、记忆 mutation、pending、导入和 job 操作。
- \`apps/web/src/components/memory/MemoryInsightsHub.tsx\`：统一中心壳和四个 section 的路由。
- \`apps/web/src/components/memory/MemoryAttentionView.tsx\`：冲突、低置信、过期、建议和失败任务处理队列。
- \`apps/web/src/components/memory/MemoryLibraryView.tsx\`：最近记住、关于你、当前工作区、全部记忆和条目详情。
- \`apps/web/src/components/memory/MemoryInsightsView.tsx\`：Persona、Workspace Brief 摘要和 Proma 建议。
- \`apps/web/src/components/memory/MemoryActivityView.tsx\`：Mutation Journal 与统一 MemoryJob 列表。
- \`apps/web/src/components/settings/MemorySettings.tsx\`：保留导出名，改为渲染高级设置。
- \`apps/web/src/components/settings/MemoryAdvancedSettings.tsx\`：主动写入、后台提取、AutoDream、召回、权限和诊断配置。
- \`apps/web/src/components/proactive/ProactiveHub.tsx\`：改为兼容导出，删除重复记忆 UI。
- \`apps/web/src/components/tabs/TabContent.tsx\`：打开中心时支持 section/deep-link。
- \`apps/web/src/components/app-shell/lume-sidebar-view-model.ts\`：侧栏文案改为“记忆与洞察”。
- \`apps/web/src/hooks/useGlobalAgentListeners.ts\`：消费 memory runtime events，递增中心刷新版本。
- \`apps/web/src/components/agent/RuntimeEventContentBlock.tsx\`：记忆通知增加打开中心的深链动作。
- \`apps/web/src/components/agent/runtime-message-view.ts\`：系统消息携带可选 MemoryCenterDeepLink。

## Task 1: 增加轻量记忆诊断契约

**Files:**
- Modify: \`packages/shared/src/types/memory.ts\`
- Modify: \`apps/sidecar/src/services/memory-v2/settings-snapshot.ts\`
- Modify: \`apps/sidecar/src/rpc/memory-handlers.ts\`
- Modify: \`apps/web/src/lib/desktop-api/memory.ts\`
- Test: \`apps/sidecar/src/services/memory-v2/settings-snapshot.test.ts\`
- Test: \`apps/sidecar/src/rpc/memory-handlers.test.ts\`

- [x] **Step 1: Add the shared diagnostics shape.**

Add this interface beside \`MemorySettingsSnapshot\`:

    export interface MemoryDiagnosticsSnapshot {
      workspaceSlug: string;
      migration: MemorySettingsSnapshot['migration'];
      extraction: MemorySettingsSnapshot['extraction'];
      retrieval: MemorySettingsSnapshot['retrieval'];
      jobs: MemorySettingsSnapshot['jobs'];
    }

Add \`DIAGNOSTICS_SNAPSHOT: "memory:diagnostics-snapshot"\` to \`MEMORY_IPC_CHANNELS\`.

- [x] **Step 2: Extract the shared status projection.**

In \`settings-snapshot.ts\`, keep \`getMemoryV2SettingsSnapshot()\` unchanged for the center and add \`getMemoryV2DiagnosticsSnapshot(workspaceSlug)\`. Refactor the existing status calculation into private helpers so the diagnostics path does not call \`listEntries\`, \`listPending\` or \`readRecentActivity\`. The returned object contains only workspaceSlug, migration, extraction, retrieval and jobs.

- [x] **Step 3: Register and expose the RPC.**

Import \`getMemoryV2DiagnosticsSnapshot\` in \`memory-handlers.ts\` and add a handler using the existing \`workspaceSlugInputSchema\`:

    [MEMORY_IPC_CHANNELS.DIAGNOSTICS_SNAPSHOT]: async (params) => {
      const input = validateInput(
        workspaceSlugInputSchema,
        params,
        MEMORY_IPC_CHANNELS.DIAGNOSTICS_SNAPSHOT
      );
      return getMemoryV2DiagnosticsSnapshot(input.workspaceSlug);
    },

Add \`getMemoryDiagnosticsSnapshot(workspaceSlug)\` to \`apps/web/src/lib/desktop-api/memory.ts\`.

- [x] **Step 4: Write the failing tests.**

In \`settings-snapshot.test.ts\`, mock the store list methods to throw and assert \`getMemoryV2DiagnosticsSnapshot('demo')\` still returns migration, extraction, retrieval and jobs. In \`memory-handlers.test.ts\`, call the new handler with \`{ workspaceSlug: 'demo' }\` and assert it has no \`workspaceEntries\`, \`globalEntries\`, \`pending\` or \`activity\` keys.

- [x] **Step 5: Run the focused tests.**

Run:

    bun test apps/sidecar/src/services/memory-v2/settings-snapshot.test.ts apps/sidecar/src/rpc/memory-handlers.test.ts

Expected: all existing tests and the new diagnostics assertions pass.

- [x] **Step 6: Commit the contract.**

    git add packages/shared/src/types/memory.ts apps/sidecar/src/services/memory-v2/settings-snapshot.ts apps/sidecar/src/rpc/memory-handlers.ts apps/web/src/lib/desktop-api/memory.ts apps/sidecar/src/services/memory-v2/settings-snapshot.test.ts apps/sidecar/src/rpc/memory-handlers.test.ts
    git commit -m "🏗️ arch(sidecar,shared,web): 增加记忆诊断轻量契约"

## Task 2: 建立中心导航和刷新状态

**Files:**
- Create: \`apps/web/src/components/memory/memory-center-state.ts\`
- Create: \`apps/web/src/components/memory/memory-center-atoms.ts\`
- Modify: \`apps/web/src/atoms/index.ts\`
- Modify: \`apps/web/src/hooks/useGlobalAgentListeners.ts\`
- Test: \`apps/web/src/components/memory/memory-center-state.test.ts\`

- [x] **Step 1: Define the navigation contract.**

Create these types and constants:

    export type MemoryCenterSection = 'attention' | 'memory' | 'insights' | 'activity';
    export type MemoryLibraryView = 'recent' | 'about' | 'workspace' | 'all';
    export interface MemoryCenterDeepLink {
      section: MemoryCenterSection;
      libraryView?: MemoryLibraryView;
      memoryId?: string;
      mutationId?: string;
      jobId?: string;
    }
    export const DEFAULT_MEMORY_CENTER_LINK: MemoryCenterDeepLink = { section: 'attention' };

Add pure helpers \`normalizeMemoryCenterLink()\` and \`isMemoryCenterLinkForWorkspace()\`; unknown sections fall back to attention and a workspace mismatch clears memoryId and jobId.

- [x] **Step 2: Add Jotai state.**

Create \`memoryCenterSectionAtom\`, \`memoryCenterDeepLinkAtom\` and \`memoryCenterVersionAtom\`. Export them from \`apps/web/src/atoms/index.ts\`.

- [x] **Step 3: Bump the version for runtime events.**

In \`useGlobalAgentListeners.ts\`, obtain \`setMemoryCenterVersion\` and increment it when \`event.type\` is \`memory.changed\`, \`memory.job.progress\` or \`memory.job.completed\`. This is renderer state only and never enters model context.

- [x] **Step 4: Test navigation normalization.**

Cover default fallback, valid section preservation, workspace mismatch clearing, and preservation of memoryId/jobId when the workspace matches.

- [x] **Step 5: Run and commit.**

Run:

    bun test apps/web/src/components/memory/memory-center-state.test.ts

Commit:

    git add apps/web/src/components/memory apps/web/src/atoms/index.ts apps/web/src/hooks/useGlobalAgentListeners.ts
    git commit -m "✨ feat(web): 增加记忆中心导航状态"

## Task 3: 提取记忆中心数据控制器

**Files:**
- Create: \`apps/web/src/components/memory/use-memory-center.ts\`
- Modify: \`apps/web/src/components/settings/MemorySettings.tsx\`
- Modify: \`apps/web/src/components/settings/memory-settings-state.ts\`
- Test: \`apps/web/src/components/memory/use-memory-center.test.tsx\`

- [x] **Step 1: Move fetch state and mutation handlers.**

Move the current \`MemorySettings\` state and handlers for \`getMemorySettingsSnapshot\`, \`readMemory\`, \`rememberMemory\`, \`updateMemoryEntry\`, \`deleteMemoryEntry\`, \`resolveMemoryPending\`, ingest jobs, organize jobs, undo and source opening into \`useMemoryCenter(workspaceSlug, deepLink)\`. The hook returns \`{ snapshot, selectedEntry, detail, busyAction, refresh, actions }\` and never loads runtime config.

- [x] **Step 2: Subscribe the controller to the version atom.**

Read \`memoryCenterVersionAtom\` in the hook and run \`refresh()\` when the version or workspace changes. Keep the existing 800–1200ms job polling only while a job is running; stop polling on terminal status.

- [x] **Step 3: Preserve revision safety and stale draft behavior.**

Keep \`detailDirty\` and selected-entry switching confirmation in the hook API. A failed mutation leaves the current snapshot and draft unchanged; a successful mutation refreshes the snapshot before showing success feedback.

- [x] **Step 4: Test controller behavior.**

Mock \`getMemorySettingsSnapshot\` and \`memoryCenterVersionAtom\` and cover initial load, version-triggered refresh, workspace change reset, successful mutation refresh, and failed mutation retaining the draft.

- [x] **Step 5: Run and commit.**

Run:

    bun test apps/web/src/components/memory/use-memory-center.test.tsx

Commit:

    git add apps/web/src/components/memory/use-memory-center.ts apps/web/src/components/memory/use-memory-center.test.tsx apps/web/src/components/settings/MemorySettings.tsx apps/web/src/components/settings/memory-settings-state.ts
    git commit -m "♻️ refactor(web): 提取记忆中心数据控制器"

## Task 4: Build the unified center views

**Files:**
- Create: \`apps/web/src/components/memory/MemoryInsightsHub.tsx\`
- Create: \`apps/web/src/components/memory/MemoryAttentionView.tsx\`
- Create: \`apps/web/src/components/memory/MemoryLibraryView.tsx\`
- Create: \`apps/web/src/components/memory/MemoryInsightsView.tsx\`
- Create: \`apps/web/src/components/memory/MemoryActivityView.tsx\`
- Modify: \`apps/web/src/components/settings/MemorySettings.tsx\`
- Test: \`apps/web/src/components/memory/MemoryInsightsHub.test.tsx\`

- [x] **Step 1: Create the center shell.**

Render four section buttons using \`memoryCenterDeepLinkAtom\`. Default to \`attention\`; section changes preserve the current workspace and clear only section-incompatible detail state.

- [x] **Step 2: Implement the attention queue.**

Render open pending items, suggested Proma records, and failed/interrupted/running memory jobs. Reuse existing resolve, suggestion feedback, cancel and retry actions. Show recent activity only when there are no actionable items.

- [x] **Step 3: Implement the memory library.**

Move the four current \`MemorySettings\` library views and \`MemoryEntryDetail\` into \`MemoryLibraryView\`. Keep existing filters and shadcn \`Input\`, \`Select\`, \`Switch\`, \`Button\`, and \`Textarea\` components.

- [x] **Step 4: Implement insights and activity.**

Move \`PersonaCard\` and Workspace Brief summary into \`MemoryInsightsView\`; move journal rows, job progress and result detail into \`MemoryActivityView\`. Each row receives a deep-link callback instead of manually changing unrelated page state.

- [x] **Step 5: Add view tests.**

Cover default attention rendering, empty attention state, pending resolution callback, section switching, no duplicate Persona in the library, and activity deep-link callbacks.

- [x] **Step 6: Run and commit.**

Run:

    bun test apps/web/src/components/memory/MemoryInsightsHub.test.tsx apps/web/src/components/proactive/ProactiveHub.test.tsx

Commit:

    git add apps/web/src/components/memory apps/web/src/components/settings/MemorySettings.tsx
    git commit -m "✨ feat(web): 创建统一记忆与洞察中心"

## Task 5: 收敛设置页为高级配置

**Files:**
- Create: \`apps/web/src/components/settings/MemoryAdvancedSettings.tsx\`
- Modify: \`apps/web/src/components/settings/MemorySettings.tsx\`
- Modify: \`apps/web/src/components/settings/settings-view-state.ts\`
- Modify: \`apps/web/src/lib/desktop-api/memory.ts\`
- Test: \`apps/web/src/components/settings/MemoryAdvancedSettings.test.tsx\`

- [x] **Step 1: Move configuration panels.**

Move automation toggles, citation mode, semantic mode, tool groups, embedding status, rerank/extraction status, and migration/backup diagnostics into \`MemoryAdvancedSettings\`.

- [x] **Step 2: Replace full Snapshot status reads.**

Use \`getMemoryRuntimeConfig()\` and \`getMemoryDiagnosticsSnapshot(workspaceSlug)\`. Do not pass entries, pending or activity into advanced settings components.

- [x] **Step 3: Keep the public export stable.**

\`MemorySettings.tsx\` exports:

    export function MemorySettings() {
      return <MemoryAdvancedSettings />;
    }

This avoids changing \`SettingsView.tsx\` and preserves existing settings deep links.

- [x] **Step 4: Update settings copy and test.**

Change the page title/subtitle to “记忆设置” and “管理主动记忆、后台整理、召回与迁移诊断”。 Test that runtime config and diagnostics are loaded and that no library controls are rendered.

- [x] **Step 5: Run and commit.**

Run:

    bun test apps/web/src/components/settings/MemoryAdvancedSettings.test.tsx apps/web/src/components/settings/settings-view-state.test.ts

Commit:

    git add apps/web/src/components/settings apps/web/src/lib/desktop-api/memory.ts
    git commit -m "♻️ refactor(web): 将记忆设置收敛为高级配置"

## Task 6: Replace the old proactive surface and update navigation

**Files:**
- Modify: \`apps/web/src/components/proactive/ProactiveHub.tsx\`
- Modify: \`apps/web/src/components/tabs/TabContent.tsx\`
- Modify: \`apps/web/src/components/app-shell/lume-sidebar-view-model.ts\`
- Modify: \`apps/web/src/components/app-shell/LeftSidebar.tsx\`
- Test: \`apps/web/src/components/app-shell/lume-sidebar-view-model.test.ts\`
- Test: \`apps/web/src/components/proactive/ProactiveHub.test.tsx\`

- [x] **Step 1: Make the old component a compatibility wrapper.**

Replace the duplicated implementation in \`ProactiveHub.tsx\` with a wrapper around \`MemoryInsightsHub\`. Keep the old export name so imports and tab restoration remain valid.

- [x] **Step 2: Change visible navigation labels.**

Change sidebar label, tab title and accessibility labels from “主动”/“主动中心” to “记忆与洞察”. Keep action ID \`proactive\` and tab ID \`__proactive__\`.

- [x] **Step 3: Remove duplicate memory fetches.**

Delete \`getMemorySettingsSnapshot\` from the compatibility wrapper and remove the old memory stat/pending/persona sections. The center owns that data.

- [x] **Step 4: Update navigation tests.**

Assert that the sidebar exposes one “记忆与洞察” action, old \`__proactive__\` tabs still open, and no “管理记忆” jump to settings remains.

- [x] **Step 5: Run and commit.**

Run:

    bun test apps/web/src/components/app-shell/lume-sidebar-view-model.test.ts apps/web/src/components/proactive/ProactiveHub.test.tsx

Commit:

    git add apps/web/src/components/proactive apps/web/src/components/tabs/TabContent.tsx apps/web/src/components/app-shell
    git commit -m "💄 ui(web): 合并主动中心与记忆入口"

## Task 7: Add chat and system deep links

**Files:**
- Modify: \`apps/web/src/components/agent/runtime-message-view.ts\`
- Modify: \`apps/web/src/components/agent/runtime-event-message-projection.ts\`
- Modify: \`apps/web/src/components/agent/RuntimeEventContentBlock.tsx\`
- Modify: \`apps/web/src/components/tabs/TabContent.tsx\`
- Create: \`apps/web/src/components/memory/open-memory-center.ts\`
- Test: \`apps/web/src/components/agent/runtime-event-message-projection.test.ts\`
- Test: \`apps/web/src/components/memory/open-memory-center.test.ts\`

- [x] **Step 1: Add a typed target to memory system messages.**

Extend memory saved/job runtime message views with optional \`target?: MemoryCenterDeepLink\`. Projection sets memoryId/mutationId for \`memory.changed\` and jobId for memory job messages.

- [x] **Step 2: Centralize tab opening.**

Create \`openMemoryCenterTab(input)\` that upserts \`__proactive__\`, activates it, and writes the section/deep-link atoms. The helper preserves existing tabs and never creates a settings tab.

- [x] **Step 3: Wire the notice action.**

Add an “打开记忆与洞察” action to MemorySavedNotice and memory job notices. The callback opens the target section and focuses the referenced item when available.

- [x] **Step 4: Test deep links.**

Cover tab upsert, target preservation, mutation target, job target, and existing tab reuse. Extend runtime projection tests to assert targets are present and do not enter model context.

- [x] **Step 5: Run and commit.**

Run:

    bun test apps/web/src/components/memory/open-memory-center.test.ts apps/web/src/components/agent/runtime-event-message-projection.test.ts

Commit:

    git add apps/web/src/components/memory apps/web/src/components/agent apps/web/src/components/tabs/TabContent.tsx
    git commit -m "✨ feat(web): 补齐记忆中心聊天深链"

## Task 8: End-to-end verification and PR checkpoint

**Files:**
- Create: \`apps/web/src/components/settings/MemorySettings.test.tsx\`
- Modify: \`apps/web/src/components/proactive/ProactiveHub.test.tsx\`
- Modify: \`apps/sidecar/src/rpc/memory-handlers.test.ts\`
- Modify: \`apps/sidecar/src/services/memory-v2/settings-snapshot.test.ts\`

- [x] **Step 1: Run focused shared and sidecar checks.**

    bun test apps/sidecar/src/services/memory-v2/settings-snapshot.test.ts apps/sidecar/src/rpc/memory-handlers.test.ts
    bun run --filter @lume/sidecar typecheck
    bun run --filter @lume/shared typecheck

Expected: diagnostics projection, existing memory RPC behavior, and shared types pass.

- [x] **Step 2: Run focused web checks.**

    bun test apps/web/src/components/memory apps/web/src/components/proactive apps/web/src/components/settings apps/web/src/components/agent/runtime-event-message-projection.test.ts
    bun run --filter @lume/web typecheck

Expected: center navigation, filters, actions, settings boundary, runtime projection and sidebar tests pass.

- [ ] **Step 3: Run the desktop smoke.**

Start the existing worktree with:

    bun dev

Verify manually: open “记忆与洞察” → “需要处理”; resolve a pending item; open “记忆” and edit an entry; open “活动” and inspect a job; click a chat memory notification and confirm it opens the correct section; open “设置 → 记忆设置” and confirm only advanced controls are present.

- [x] **Step 4: Inspect the final diff.**

    git diff origin/main...HEAD --stat
    git diff --check
    git status --short

Expected: no generated files, no duplicate memory management surface, and only planned web/shared/sidecar/docs files changed.

- [x] **Step 5: Commit the verification checkpoint.**

    git commit --allow-empty -m "✅ test(web,sidecar,shared): 验证记忆与洞察中心闭环"

## Self-review checklist

- Spec coverage: all four center sections, advanced settings boundary, diagnostics projection, event refresh, deep links, error states, navigation compatibility and tests have explicit tasks.
- Placeholder scan: no incomplete marker or unspecified implementation step is required.
- Type consistency: \`MemoryDiagnosticsSnapshot\`, \`MemoryCenterDeepLink\`, \`memoryCenterVersionAtom\` and \`openMemoryCenterTab\` are defined before their consumers.
- Scope: this remains one cohesive UI capability change; storage, retrieval and Agent runtime remain outside this plan.
