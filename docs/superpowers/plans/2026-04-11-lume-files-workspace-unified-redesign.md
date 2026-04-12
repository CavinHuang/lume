# Lume 文件与工作区统一重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 同时重构 Lume 的磁盘落盘结构与 Agent 右侧文件面板/文件提升交互，使 UI 三层模型与实际目录结构稳定对齐。

**Architecture:** 先从 `packages/shared + apps/sidecar` 固化新的 workspace/thread 落盘 contract 与迁移路径，再让 `apps/web` 的右侧面板和消息流推荐提升卡片建立在这套稳定结构之上。右侧面板只负责展示结构，任务完成后的“推荐提升到共享层”放在消息流中完成。

**Tech Stack:** TypeScript strict, React 18, Jotai, Tauri desktop bridge, Bun sidecar, markdown bootstrap files

---

## File Structure

### Core Contracts / Sidecar

- Modify: `D:/workspace/projects/ai-projects/lume/packages/shared/src/types/agent.ts`
- Modify: `D:/workspace/projects/ai-projects/lume/packages/shared/src/types/workspace-bootstrap.ts`
- Modify: `D:/workspace/projects/ai-projects/lume/apps/sidecar/src/services/infra/config-paths.ts`
- Modify: `D:/workspace/projects/ai-projects/lume/apps/sidecar/src/services/system/workspace-bootstrap-service.ts`
- Modify: `D:/workspace/projects/ai-projects/lume/apps/sidecar/src/services/agent/agent-thread-manager.ts`
- Modify: `D:/workspace/projects/ai-projects/lume/apps/sidecar/src/services/agent/agent-files-service.ts`
- Create: `D:/workspace/projects/ai-projects/lume/apps/sidecar/src/services/agent/agent-file-promotion-service.ts`
- Create: `D:/workspace/projects/ai-projects/lume/apps/sidecar/src/services/agent/agent-file-promotion-service.test.ts`
- Modify: `D:/workspace/projects/ai-projects/lume/apps/sidecar/src/rpc/schemas.ts`
- Modify: `D:/workspace/projects/ai-projects/lume/apps/sidecar/src/rpc/agent-handlers.ts`

### Web UI

- Create: `D:/workspace/projects/ai-projects/lume/apps/web/components/agent/file-layer-copy.ts`
- Create: `D:/workspace/projects/ai-projects/lume/apps/web/components/agent/file-layer-copy.test.ts`
- Create: `D:/workspace/projects/ai-projects/lume/apps/web/components/agent/FilePromotionCard.tsx`
- Create: `D:/workspace/projects/ai-projects/lume/apps/web/components/agent/file-promotion-card.test.tsx`
- Modify: `D:/workspace/projects/ai-projects/lume/apps/web/components/agent/AgentSidePanel.tsx`
- Modify: `D:/workspace/projects/ai-projects/lume/apps/web/components/agent/AgentMessages.tsx`
- Modify: `D:/workspace/projects/ai-projects/lume/apps/web/components/agent/AgentView.tsx`
- Modify: `D:/workspace/projects/ai-projects/lume/apps/web/components/file-browser/FileBrowser.tsx`
- Modify: `D:/workspace/projects/ai-projects/lume/apps/web/components/file-browser/FileDropZone.tsx`
- Modify: `D:/workspace/projects/ai-projects/lume/apps/web/lib/desktop-api/agent.ts`

### Tests / Smoke / Skills

- Modify: `D:/workspace/projects/ai-projects/lume/apps/sidecar/scripts/smoke-restart-restore.mjs`
- Modify: `D:/workspace/projects/ai-projects/lume/scripts/smoke-core.mjs`
- Create: `D:/workspace/projects/ai-projects/lume/apps/sidecar/default-skills/lume-file-governance/SKILL.md`
- Modify: `D:/workspace/projects/ai-projects/lume/apps/sidecar/src/services/system/default-skills-seeder.ts`

---

### Task 1: 固定新的 workspace/thread 目标目录结构

**Files:**
- Modify: `D:/workspace/projects/ai-projects/lume/apps/sidecar/src/services/infra/config-paths.ts`
- Test: `D:/workspace/projects/ai-projects/lume/apps/sidecar/src/services/infra/config-paths.test.ts` (create if missing)

- [ ] **Step 1: 写失败测试，固定新的 threads/resources/.meta 结构**

```ts
import { describe, expect, test } from "bun:test";
import {
  getAgentWorkspacePath,
  getWorkspaceResourcesPath,
  getWorkspaceMetaPath,
  getAgentThreadRootPath,
  getAgentThreadFilesPath
} from "./config-paths";

describe("config-paths workspace layout", () => {
  test("workspace 应暴露 resources、threads 和 .meta", () => {
    const workspace = getAgentWorkspacePath("demo");
    expect(getWorkspaceResourcesPath("demo")).toBe(`${workspace}\\resources`);
    expect(getWorkspaceMetaPath("demo")).toBe(`${workspace}\\.meta`);
    expect(getAgentThreadRootPath("demo", "thread-1")).toBe(`${workspace}\\threads\\thread-1`);
    expect(getAgentThreadFilesPath("demo", "thread-1")).toBe(`${workspace}\\threads\\thread-1\\files`);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test apps/sidecar/src/services/infra/config-paths.test.ts`
Expected: FAIL with missing exports such as `getWorkspaceResourcesPath`

- [ ] **Step 3: 在 config-paths 中新增新目录路径函数**

```ts
export function getWorkspaceResourcesPath(workspaceSlug: string): string {
  return ensureDir(join(getAgentWorkspacePath(workspaceSlug), "resources"), "工作区共享文件目录");
}

export function getWorkspaceMetaPath(workspaceSlug: string): string {
  return ensureDir(join(getAgentWorkspacePath(workspaceSlug), ".meta"), "工作区元数据目录");
}

export function getAgentThreadRootPath(workspaceSlug: string, threadId: string): string {
  const safeThreadId = assertSafeSegment(threadId, "agent thread id");
  return ensureDir(join(getAgentWorkspacePath(workspaceSlug), "threads", safeThreadId), "Agent 线程根目录");
}

export function getAgentThreadFilesPath(workspaceSlug: string, threadId: string): string {
  return ensureDir(join(getAgentThreadRootPath(workspaceSlug, threadId), "files"), "Agent 线程文件目录");
}
```

- [ ] **Step 4: 更新旧的线程目录函数改为基于 `threads/<thread-id>/`**

```ts
export function getAgentSessionWorkspacePath(workspaceSlug: string, sessionId: string): string {
  return getAgentThreadRootPath(workspaceSlug, sessionId);
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `bun test apps/sidecar/src/services/infra/config-paths.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/sidecar/src/services/infra/config-paths.ts apps/sidecar/src/services/infra/config-paths.test.ts
git commit -m "refactor: ♻️固定workspace与thread新目录骨架"
```

### Task 2: 删除不再需要的 workspace/thread 系统文件

**Files:**
- Modify: `D:/workspace/projects/ai-projects/lume/apps/sidecar/src/services/system/workspace-bootstrap-service.ts`
- Modify: `D:/workspace/projects/ai-projects/lume/templates/workspace/BOOTSTRAP.md`
- Test: `D:/workspace/projects/ai-projects/lume/apps/sidecar/src/services/system/workspace-bootstrap-service.test.ts`

- [ ] **Step 1: 写失败测试，确认不再创建 `BOOTSTRAP.md`**

```ts
test("ensureBootstrapFiles 不应再创建 BOOTSTRAP.md", () => {
  const result = ensureBootstrapFiles("demo");
  expect(result.created).not.toContain("BOOTSTRAP.md");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test apps/sidecar/src/services/system/workspace-bootstrap-service.test.ts`
Expected: FAIL because BOOTSTRAP.md is still created

- [ ] **Step 3: 从默认 bootstrap 文件配置中移除 `BOOTSTRAP`**

```ts
const BOOTSTRAP_FILE_CONFIGS: BootstrapFileMeta[] = [
  { type: "SOUL", ... },
  { type: "USER", ... },
  { type: "IDENTITY", ... },
  { type: "AGENTS", ... },
  { type: "TOOLS", ... },
  { type: "HEARTBEAT", ... },
  { type: "MEMORY", ... }
];
```

- [ ] **Step 4: 更新默认创建文件列表**

```ts
fileTypes: BootstrapFileType[] = ["SOUL", "USER", "IDENTITY", "AGENTS", "TOOLS"]
```

- [ ] **Step 5: 运行测试确认通过**

Run: `bun test apps/sidecar/src/services/system/workspace-bootstrap-service.test.ts`
Expected: PASS and no `BOOTSTRAP.md`

- [ ] **Step 6: Commit**

```bash
git add apps/sidecar/src/services/system/workspace-bootstrap-service.ts apps/sidecar/src/services/system/workspace-bootstrap-service.test.ts
git commit -m "refactor: ♻️移除BOOTSTRAP工作区引导文件"
```

### Task 3: 将 thread 根目录拆分为 files/plans/artifacts/.context

**Files:**
- Modify: `D:/workspace/projects/ai-projects/lume/apps/sidecar/src/services/agent/agent-thread-manager.ts`
- Modify: `D:/workspace/projects/ai-projects/lume/apps/sidecar/src/services/agent/agent-files-service.ts`
- Test: `D:/workspace/projects/ai-projects/lume/apps/sidecar/src/services/agent/agent-thread-manager.test.ts`

- [ ] **Step 1: 写失败测试，确认新 thread 目录应包含 `files/` 与 `.context/`**

```ts
test("createAgentThread 应创建 files 与 .context 子目录", () => {
  const thread = createAgentThread("t", undefined, workspaceId);
  const root = getAgentThreadRootPath(workspace.slug, thread.id);
  expect(existsSync(join(root, "files"))).toBe(true);
  expect(existsSync(join(root, ".context"))).toBe(true);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test apps/sidecar/src/services/agent/agent-thread-manager.test.ts`
Expected: FAIL because thread files are currently mixed at root

- [ ] **Step 3: 在线程创建时显式创建 `files/ plans/ artifacts/ .context/`**

```ts
mkdirSync(join(threadDir, "files"), { recursive: true });
mkdirSync(join(threadDir, "plans"), { recursive: true });
mkdirSync(join(threadDir, "artifacts"), { recursive: true });
mkdirSync(join(threadDir, ".context"), { recursive: true });
```

- [ ] **Step 4: 更新保存文件逻辑默认写入 `files/`**

```ts
const threadFilesDir = getAgentThreadFilesPath(input.workspaceSlug, input.threadId);
const targetPath = resolve(join(threadFilesDir, file.filename));
```

- [ ] **Step 5: 更新 plans 目录解析**

```ts
function resolveSessionPlansDir(workspaceSlug: string, sessionId: string): string {
  return join(getAgentThreadRootPath(workspaceSlug, sessionId), "plans");
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `bun test apps/sidecar/src/services/agent/agent-thread-manager.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/sidecar/src/services/agent/agent-thread-manager.ts apps/sidecar/src/services/agent/agent-files-service.ts apps/sidecar/src/services/agent/agent-thread-manager.test.ts
git commit -m "refactor: ♻️拆分thread目录为files plans artifacts context"
```

### Task 4: 将 workspace 共享层固定为 `resources/`

**Files:**
- Modify: `D:/workspace/projects/ai-projects/lume/apps/sidecar/src/services/agent/agent-files-service.ts`
- Modify: `D:/workspace/projects/ai-projects/lume/apps/web/components/agent/AgentSidePanel.tsx`
- Modify: `D:/workspace/projects/ai-projects/lume/apps/web/components/file-browser/FileDropZone.tsx`

- [ ] **Step 1: 写失败测试，确认共享层使用 `resources/`**

```ts
test("workspace shared files 应定位到 resources 目录", () => {
  expect(getWorkspaceResourcesPath("demo")).toContain("resources");
});
```

- [ ] **Step 2: 运行测试确认通过/缺失后继续实现**

Run: `bun test apps/sidecar/src/services/infra/config-paths.test.ts`
Expected: PASS after Task 1

- [ ] **Step 3: 在 sidecar 中新增资源目录保存辅助函数**

```ts
export function saveFilesToWorkspaceResources(...) {
  const root = getWorkspaceResourcesPath(workspaceSlug);
  ...
}
```

- [ ] **Step 4: 在右侧面板中将“工作区文件”固定映射到 `resources/`**

```tsx
const workspacePath = await getAgentWorkspaceResourcesPath(workspaceSlug);
```

- [ ] **Step 5: 更新上传区文案**

```tsx
<p>添加文件到工作区共享文件</p>
```

- [ ] **Step 6: 运行 smoke**

Run: `bun run --filter @lume/web test:smoke`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/sidecar/src/services/agent/agent-files-service.ts apps/web/components/agent/AgentSidePanel.tsx apps/web/components/file-browser/FileDropZone.tsx
git commit -m "feat: ✨固定工作区共享文件映射到resources"
```

### Task 5: 将内部元数据下沉到 `.meta/`

**Files:**
- Modify: `D:/workspace/projects/ai-projects/lume/apps/sidecar/src/services/infra/config-paths.ts`
- Modify: `D:/workspace/projects/ai-projects/lume/apps/sidecar/src/services/system/workspace-bootstrap-service.ts`
- Modify: `D:/workspace/projects/ai-projects/lume/apps/sidecar/src/services/memory/memory-path-utils.ts`

- [ ] **Step 1: 写失败测试，确认 `mcp.json` 与 sqlite 下沉到 `.meta/`**

```ts
test("workspace internal state 应写入 .meta", () => {
  expect(getWorkspaceMcpPath("demo")).toContain(".meta");
  expect(getWorkspaceMemoryDbPath("demo")).toContain(".meta");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test apps/sidecar/src/services/infra/config-paths.test.ts`
Expected: FAIL because files still resolve at workspace root

- [ ] **Step 3: 修改配置路径**

```ts
export function getWorkspaceMcpPath(slug: string): string {
  return join(getWorkspaceMetaPath(slug), "mcp.json");
}

export function getWorkspaceMemoryDbPath(workspaceSlug: string): string {
  return join(getWorkspaceMetaPath(workspaceSlug), "memory.sqlite");
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test apps/sidecar/src/services/infra/config-paths.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/sidecar/src/services/infra/config-paths.ts apps/sidecar/src/services/memory/memory-path-utils.ts
git commit -m "refactor: ♻️将workspace内部状态下沉到.meta"
```

### Task 6: 实现文件提升 contract 与 sidecar 服务

**Files:**
- Modify: `D:/workspace/projects/ai-projects/lume/packages/shared/src/types/agent.ts`
- Modify: `D:/workspace/projects/ai-projects/lume/apps/web/lib/desktop-api/agent.ts`
- Modify: `D:/workspace/projects/ai-projects/lume/apps/sidecar/src/rpc/schemas.ts`
- Modify: `D:/workspace/projects/ai-projects/lume/apps/sidecar/src/rpc/agent-handlers.ts`
- Create: `D:/workspace/projects/ai-projects/lume/apps/sidecar/src/services/agent/agent-file-promotion-service.ts`
- Create: `D:/workspace/projects/ai-projects/lume/apps/sidecar/src/services/agent/agent-file-promotion-service.test.ts`

- [ ] **Step 1: 写失败测试，固定提升 contract**

```ts
import { describe, expect, test } from "bun:test";
import { AGENT_IPC_CHANNELS } from "@lume/shared";

describe("agent file promotion contract", () => {
  test("应暴露提升文件到资源层的 IPC 通道", () => {
    expect(AGENT_IPC_CHANNELS.PROMOTE_FILE_TO_WORKSPACE).toBe("agent:promote-file-to-workspace");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test packages/shared/src/types/agent.promotion.test.ts`
Expected: FAIL because channel is missing

- [ ] **Step 3: 在 shared 中增加输入类型与 channel**

```ts
export interface PromoteFileToWorkspaceInput {
  workspaceSlug: string;
  threadId: string;
  filePath: string;
  conflictMode?: "overwrite" | "rename";
}
```

- [ ] **Step 4: 在 sidecar 中实现复制提升服务**

```ts
copyFileSync(sourcePath, targetPath);
return { ok: true, path: targetPath };
```

- [ ] **Step 5: 增加同名冲突测试与处理**

```ts
if (existsSync(targetPath) && conflictMode !== "overwrite") {
  throw new Error("同名文件已存在");
}
```

- [ ] **Step 6: 暴露 web desktop-api 方法**

```ts
export async function promoteFileToWorkspace(input: PromoteFileToWorkspaceInput) {
  return sidecarCall(AGENT_IPC_CHANNELS.PROMOTE_FILE_TO_WORKSPACE, input);
}
```

- [ ] **Step 7: 运行侧边服务测试**

Run: `bun test apps/sidecar/src/services/agent/agent-file-promotion-service.test.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/types/agent.ts apps/web/lib/desktop-api/agent.ts apps/sidecar/src/rpc/schemas.ts apps/sidecar/src/rpc/agent-handlers.ts apps/sidecar/src/services/agent/agent-file-promotion-service.ts apps/sidecar/src/services/agent/agent-file-promotion-service.test.ts
git commit -m "feat: ✨实现任务文件提升到workspace resources"
```

### Task 7: 实现任务完成后的推荐提升卡片

**Files:**
- Create: `D:/workspace/projects/ai-projects/lume/apps/web/components/agent/FilePromotionCard.tsx`
- Create: `D:/workspace/projects/ai-projects/lume/apps/web/components/agent/file-promotion-card.test.tsx`
- Modify: `D:/workspace/projects/ai-projects/lume/apps/web/components/agent/AgentMessages.tsx`
- Modify: `D:/workspace/projects/ai-projects/lume/apps/web/components/agent/AgentView.tsx`

- [ ] **Step 1: 写失败测试，固定卡片标题与基础行为**

```tsx
import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { FilePromotionCard } from "./FilePromotionCard";

describe("FilePromotionCard", () => {
  test("应渲染推荐提升文案", () => {
    const html = renderToString(
      <FilePromotionCard
        files={[{ name: "report.md", path: "report.md", status: "suggested" }]}
        onPromote={() => {}}
        onDismiss={() => {}}
      />
    );
    expect(html).toContain("这些文件可能值得沉淀到工作区共享文件");
    expect(html).toContain("report.md");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test apps/web/components/agent/file-promotion-card.test.tsx`
Expected: FAIL with missing component

- [ ] **Step 3: 实现最小卡片**

```tsx
export function FilePromotionCard(...) {
  return (
    <div className="rounded-lg border border-border/60 bg-muted/25 px-3.5 py-3">
      ...
    </div>
  );
}
```

- [ ] **Step 4: 在 AgentView 中增加候选状态**

```ts
const [promotionFiles, setPromotionFiles] = React.useState<PromotionCandidate[]>([]);
```

- [ ] **Step 5: 在任务完成后筛选 `threads/<thread-id>/files/` 中的候选**

```ts
if (!streaming && sessionSwitching === false) {
  // listAgentDirectory on thread files dir and build promotion candidates
}
```

- [ ] **Step 6: 在 AgentMessages 中插入卡片**

```tsx
{promotionFiles.length > 0 ? (
  <FilePromotionCard files={promotionFiles} onPromote={handlePromote} onDismiss={handleDismiss} />
) : null}
```

- [ ] **Step 7: 调用 `promoteFileToWorkspace` 并刷新资源层**

```ts
await promoteFileToWorkspace(...);
setPromotionFiles((prev) => prev.map((f) => f.path === target.path ? { ...f, status: "promoted" } : f));
```

- [ ] **Step 8: 运行 smoke**

Run: `bun run --filter @lume/web test:smoke`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add apps/web/components/agent/FilePromotionCard.tsx apps/web/components/agent/file-promotion-card.test.tsx apps/web/components/agent/AgentMessages.tsx apps/web/components/agent/AgentView.tsx
git commit -m "feat: ✨新增任务完成后的文件提升推荐卡片"
```

### Task 8: 更新恢复与 smoke 回归

**Files:**
- Modify: `D:/workspace/projects/ai-projects/lume/apps/sidecar/scripts/smoke-restart-restore.mjs`
- Modify: `D:/workspace/projects/ai-projects/lume/scripts/smoke-core.mjs`

- [ ] **Step 1: 扩展 restart smoke 到新目录结构**

```js
const threadRoot = await sidecar.call("agent:get-thread-path", ...);
assert(threadRoot.includes("\\threads\\"), "thread root not migrated");
```

- [ ] **Step 2: 增加 resources 提升 smoke**

```js
await sidecar.call("agent:promote-file-to-workspace", ...);
```

- [ ] **Step 3: 运行 smoke**

Run: `bun run smoke:core`
Expected: PASS with `SMOKE_RESTART_RESTORE_OK`

- [ ] **Step 4: Commit**

```bash
git add apps/sidecar/scripts/smoke-restart-restore.mjs scripts/smoke-core.mjs
git commit -m "test: ✅补齐落盘结构与文件提升回归"
```

### Task 9: 创建 Lume 自我进化文件治理 skill

**Files:**
- Create: `D:/workspace/projects/ai-projects/lume/apps/sidecar/default-skills/lume-file-governance/SKILL.md`
- Modify: `D:/workspace/projects/ai-projects/lume/apps/sidecar/src/services/system/default-skills-seeder.ts`

- [ ] **Step 1: 写 skill 核心原则**

```md
# Lume 文件治理

- workspace 是唯一主根
- resources 是工作区共享资料层
- threads/<thread-id>/files 是当前任务文件层
- 外部附加目录仅为临时上下文
```

- [ ] **Step 2: 补充保留/删除决策**

```md
- 删除 BOOTSTRAP.md
- 删除 .claude/
- 删除 .note
- 保留 .context/
```

- [ ] **Step 3: 在 seeder 中注册 skill**

```ts
const DEFAULT_SKILLS = [
  ...,
  "lume-file-governance"
];
```

- [ ] **Step 4: 运行 smoke 验证 skill 同步仍正常**

Run: `bun run --filter @lume/sidecar smoke:restart-restore`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/sidecar/default-skills/lume-file-governance/SKILL.md apps/sidecar/src/services/system/default-skills-seeder.ts
git commit -m "feat: ✨沉淀文件治理理念为Lume自我进化skill"
```

---

## Self-Review

### Spec coverage

- UI 三层模型与文案：Task 4、Task 7
- workspace/thread 真实目录结构：Task 1、Task 3、Task 4、Task 5
- 删除项：Task 2、Task 3
- 提升卡片与显式沉淀规则：Task 6、Task 7
- 文件治理 skill：Task 9

无 spec gap。

### Placeholder scan

- 无 TBD/TODO
- 每个任务均给出明确文件路径
- 所有代码步骤都提供最小代码块
- 所有验证步骤都包含命令与预期

### Type consistency

- 统一使用 `threadId` 表示线程对象
- 统一使用 `resources/` 表示共享层
- 统一使用 `PromoteFileToWorkspaceInput` 表示提升动作输入
- `.meta/` 仅承载内部状态，不再承担主语义

---

Plan complete and saved to `docs/superpowers/plans/2026-04-11-lume-files-workspace-unified-redesign.md`. Two execution options:

1. Subagent-Driven (recommended) - I dispatch a fresh subagent per task, review between tasks, fast iteration

2. Inline Execution - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
