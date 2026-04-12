# Lume 文件与工作区重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 重构 Agent 文件体系与右侧面板，使用户能稳定理解 `当前任务文件 / 工作区共享文件 / 外部附加目录` 三层模型，并在任务完成后收到“提升到工作区共享文件”的明确建议。

**Architecture:** 保持 `web + sidecar + shared` 分层不变。`apps/web` 负责三层文件 UI 与推荐卡片展示，`apps/sidecar` 负责文件归属、提升动作与持久化规则，`packages/shared` 承载新增 contract。右侧面板仅负责结构展示，推荐提升逻辑放在消息流里。

**Tech Stack:** React 18, Jotai, Tauri desktop bridge, Bun sidecar, TypeScript strict

---

## File Structure

### 需要修改的核心文件

- Modify: `D:/workspace/projects/ai-projects/lume/apps/web/components/agent/AgentSidePanel.tsx`
  负责右侧文件面板，调整为清晰的三层信息架构与统一文案。
- Modify: `D:/workspace/projects/ai-projects/lume/apps/web/components/file-browser/FileBrowser.tsx`
  负责文件树浏览、选择、重命名、移动、删除。
- Modify: `D:/workspace/projects/ai-projects/lume/apps/web/components/file-browser/FileDropZone.tsx`
  负责两主文件层的上传入口语义。
- Modify: `D:/workspace/projects/ai-projects/lume/apps/web/components/agent/AgentMessages.tsx`
  在任务完成后插入“推荐提升”系统卡片。
- Modify: `D:/workspace/projects/ai-projects/lume/apps/web/components/agent/TaskProgressCard.tsx`
  如有必要，仅保留运行态展示职责，避免和推荐卡片混淆。
- Modify: `D:/workspace/projects/ai-projects/lume/apps/web/components/agent/AgentView.tsx`
  接入新的推荐卡片展示与提升动作入口。
- Modify: `D:/workspace/projects/ai-projects/lume/apps/web/lib/desktop-api/agent.ts`
  暴露“提升文件到工作区共享文件”等新接口。
- Modify: `D:/workspace/projects/ai-projects/lume/apps/sidecar/src/rpc/agent-handlers.ts`
  注册提升相关 RPC。
- Modify: `D:/workspace/projects/ai-projects/lume/apps/sidecar/src/rpc/schemas.ts`
  增加提升动作、冲突处理相关 schema。
- Modify: `D:/workspace/projects/ai-projects/lume/apps/sidecar/src/services/agent/agent-files-service.ts`
  实现文件提升、重名冲突处理、共享层刷新。
- Modify: `D:/workspace/projects/ai-projects/lume/packages/shared/src/types/agent.ts`
  增加文件提升相关 contract。
- Modify: `D:/workspace/projects/ai-projects/lume/apps/web/components/agent/agent-session-lifecycle.test.ts`
  如状态切换行为受影响，需要补回归测试。
- Modify: `D:/workspace/projects/ai-projects/lume/apps/sidecar/scripts/smoke-restart-restore.mjs`
  扩展恢复与文件提升后的 smoke。

### 建议新增文件

- Create: `D:/workspace/projects/ai-projects/lume/apps/web/components/agent/FilePromotionCard.tsx`
  独立承载“推荐提升到工作区共享文件”的消息卡片，避免和任务进度卡片混在一起。
- Create: `D:/workspace/projects/ai-projects/lume/apps/web/components/agent/file-promotion-card.test.tsx`
  覆盖推荐展示与操作分支。
- Create: `D:/workspace/projects/ai-projects/lume/apps/sidecar/src/services/agent/agent-file-promotion-service.ts`
  将“提升到共享层”的业务从普通文件服务中拆开，边界更清楚。
- Create: `D:/workspace/projects/ai-projects/lume/apps/sidecar/src/services/agent/agent-file-promotion-service.test.ts`
  覆盖复制提升、同名冲突、取消行为。
- Create: `D:/workspace/projects/ai-projects/lume/apps/web/components/agent/file-layer-copy.ts`
  纯函数：从 spec 文案与层定义生成 UI 文案/标签，避免散落硬编码。
- Create: `D:/workspace/projects/ai-projects/lume/apps/web/components/agent/file-layer-copy.test.ts`
  覆盖三层命名与说明文案。
- Create: `D:/workspace/projects/ai-projects/lume/apps/sidecar/default-skills/lume-file-governance/SKILL.md`
  收尾任务要求的 `Lume` 自我进化 skill。

---

### Task 1: 固化三层文件模型文案与前端结构约束

**Files:**
- Create: `D:/workspace/projects/ai-projects/lume/apps/web/components/agent/file-layer-copy.ts`
- Test: `D:/workspace/projects/ai-projects/lume/apps/web/components/agent/file-layer-copy.test.ts`
- Modify: `D:/workspace/projects/ai-projects/lume/apps/web/components/agent/AgentSidePanel.tsx`

- [ ] **Step 1: 写失败测试，固定三层模型文案**

```ts
import { describe, expect, test } from "bun:test";
import { FILE_LAYER_COPY } from "./file-layer-copy";

describe("file-layer-copy", () => {
  test("应输出三层文件语义", () => {
    expect(FILE_LAYER_COPY.task.title).toBe("当前任务文件");
    expect(FILE_LAYER_COPY.workspace.title).toBe("工作区共享文件");
    expect(FILE_LAYER_COPY.attached.title).toBe("外部附加目录");
    expect(FILE_LAYER_COPY.attached.description).toContain("临时");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test apps/web/components/agent/file-layer-copy.test.ts`
Expected: FAIL with `Cannot find module "./file-layer-copy"`

- [ ] **Step 3: 最小实现文案常量**

```ts
export const FILE_LAYER_COPY = {
  task: {
    title: "当前任务文件",
    description: "本次任务专属产物，仅当前任务可见"
  },
  workspace: {
    title: "工作区共享文件",
    description: "当前工作区内多个任务可复用的长期资料"
  },
  attached: {
    title: "外部附加目录",
    description: "临时挂载，不属于工作区资产"
  }
} as const;
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test apps/web/components/agent/file-layer-copy.test.ts`
Expected: PASS

- [ ] **Step 5: 将 AgentSidePanel 标题与说明统一替换为该常量**

```tsx
<span className="text-[11px] font-medium text-muted-foreground">
  {FILE_LAYER_COPY.task.title}
</span>
<TooltipContent side="bottom" className="max-w-[220px]">
  <p>{FILE_LAYER_COPY.task.description}</p>
</TooltipContent>
```

- [ ] **Step 6: 运行 smoke 验证面板未破坏**

Run: `bun run --filter @lume/web test:smoke`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/web/components/agent/file-layer-copy.ts apps/web/components/agent/file-layer-copy.test.ts apps/web/components/agent/AgentSidePanel.tsx
git commit -m "feat: ✨统一文件三层模型文案"
```

### Task 2: 收紧上传与附加入口语义

**Files:**
- Modify: `D:/workspace/projects/ai-projects/lume/apps/web/components/file-browser/FileDropZone.tsx`
- Modify: `D:/workspace/projects/ai-projects/lume/apps/web/components/agent/AgentSidePanel.tsx`
- Test: `D:/workspace/projects/ai-projects/lume/apps/web/scripts/smoke-web-regression.mjs`

- [ ] **Step 1: 写失败测试，固定上传入口文案**

```ts
import { describe, expect, test } from "bun:test";
import { FILE_LAYER_COPY } from "../agent/file-layer-copy";

describe("file layer upload semantics", () => {
  test("task 与 workspace 上传动作应分离", () => {
    expect(FILE_LAYER_COPY.task.title).not.toBe(FILE_LAYER_COPY.workspace.title);
  });
});
```

- [ ] **Step 2: 运行测试确认当前无专门语义实现**

Run: `bun test apps/web/components/agent/file-layer-copy.test.ts`
Expected: PASS, but UI still lacks explicit action labels; proceed to implementation

- [ ] **Step 3: 修改 FileDropZone 文案与提示**

```tsx
<p>{isWorkspace ? "添加文件到工作区共享文件" : "添加文件到当前任务文件"}</p>
```

- [ ] **Step 4: 在 AgentSidePanel 中为附加目录入口单独命名**

```tsx
<div className="text-[11px] font-medium text-muted-foreground mb-1 px-3">
  {FILE_LAYER_COPY.attached.title}
</div>
```

- [ ] **Step 5: 运行 smoke 验证上传入口仍正常**

Run: `bun run --filter @lume/web test:smoke`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/web/components/file-browser/FileDropZone.tsx apps/web/components/agent/AgentSidePanel.tsx
git commit -m "feat: ✨明确任务层与工作区层上传语义"
```

### Task 3: 将“推荐提升”从设计落成独立消息卡片

**Files:**
- Create: `D:/workspace/projects/ai-projects/lume/apps/web/components/agent/FilePromotionCard.tsx`
- Test: `D:/workspace/projects/ai-projects/lume/apps/web/components/agent/file-promotion-card.test.tsx`
- Modify: `D:/workspace/projects/ai-projects/lume/apps/web/components/agent/AgentMessages.tsx`

- [ ] **Step 1: 写失败测试，固定卡片最小展示**

```tsx
import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { FilePromotionCard } from "./FilePromotionCard";

describe("FilePromotionCard", () => {
  test("应展示推荐提升标题与文件名", () => {
    const html = renderToString(
      <FilePromotionCard
        files={[{ path: "report.md", name: "report.md", status: "suggested" }]}
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
Expected: FAIL with `Cannot find module "./FilePromotionCard"`

- [ ] **Step 3: 实现最小 FilePromotionCard**

```tsx
export function FilePromotionCard(...) {
  return (
    <div className="rounded-lg border border-border/60 bg-muted/25 px-3.5 py-3">
      <div className="text-[13px] font-medium">这些文件可能值得沉淀到工作区共享文件</div>
      ...
    </div>
  );
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test apps/web/components/agent/file-promotion-card.test.tsx`
Expected: PASS

- [ ] **Step 5: 在 AgentMessages 中为任务完成后插入推荐卡片占位接口**

```tsx
{promotionFiles.length > 0 ? (
  <FilePromotionCard files={promotionFiles} onPromote={handlePromote} onDismiss={handleDismiss} />
) : null}
```

- [ ] **Step 6: 运行 smoke 确认消息区稳定**

Run: `bun run --filter @lume/web test:smoke`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/web/components/agent/FilePromotionCard.tsx apps/web/components/agent/file-promotion-card.test.tsx apps/web/components/agent/AgentMessages.tsx
git commit -m "feat: ✨新增文件提升推荐卡片"
```

### Task 4: 新增共享层提升 contract

**Files:**
- Modify: `D:/workspace/projects/ai-projects/lume/packages/shared/src/types/agent.ts`
- Modify: `D:/workspace/projects/ai-projects/lume/apps/web/lib/desktop-api/agent.ts`
- Modify: `D:/workspace/projects/ai-projects/lume/apps/sidecar/src/rpc/schemas.ts`
- Modify: `D:/workspace/projects/ai-projects/lume/apps/sidecar/src/rpc/agent-handlers.ts`

- [ ] **Step 1: 写共享 contract 失败测试**

```ts
import { describe, expect, test } from "bun:test";
import { AGENT_IPC_CHANNELS } from "@lume/shared";

describe("agent promotion ipc", () => {
  test("应暴露提升文件到工作区共享层的通道", () => {
    expect(AGENT_IPC_CHANNELS.PROMOTE_FILE_TO_WORKSPACE).toBeDefined();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test packages/shared/src/types/agent.promotion.test.ts`
Expected: FAIL because constant does not exist

- [ ] **Step 3: 在 shared 中新增 contract**

```ts
export interface PromoteFileToWorkspaceInput {
  workspaceSlug: string;
  threadId: string;
  filePath: string;
  conflictMode?: "overwrite" | "rename";
}

PROMOTE_FILE_TO_WORKSPACE: "agent:promote-file-to-workspace",
```

- [ ] **Step 4: 在前端 desktop-api 暴露方法**

```ts
export async function promoteFileToWorkspace(input: PromoteFileToWorkspaceInput): Promise<{ ok: true; path: string }> {
  return sidecarCall(AGENT_IPC_CHANNELS.PROMOTE_FILE_TO_WORKSPACE, input);
}
```

- [ ] **Step 5: 在 sidecar schema 与 handler 中注册**

```ts
export const promoteFileToWorkspaceInputSchema = z.object({
  workspaceSlug: idSchema,
  threadId: idSchema,
  filePath: idSchema,
  conflictMode: z.enum(["overwrite", "rename"]).optional()
});
```

- [ ] **Step 6: 运行 contract smoke**

Run: `bun run --filter @lume/web test:smoke`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/types/agent.ts apps/web/lib/desktop-api/agent.ts apps/sidecar/src/rpc/schemas.ts apps/sidecar/src/rpc/agent-handlers.ts
git commit -m "feat: ✨补齐文件提升共享层的跨层契约"
```

### Task 5: 实现 sidecar 文件提升服务

**Files:**
- Create: `D:/workspace/projects/ai-projects/lume/apps/sidecar/src/services/agent/agent-file-promotion-service.ts`
- Create: `D:/workspace/projects/ai-projects/lume/apps/sidecar/src/services/agent/agent-file-promotion-service.test.ts`
- Modify: `D:/workspace/projects/ai-projects/lume/apps/sidecar/src/services/agent/agent-files-service.ts`

- [ ] **Step 1: 写失败测试，覆盖复制提升**

```ts
test("应将任务文件复制到工作区共享层并保留原文件", async () => {
  const result = await promoteFileToWorkspace(...);
  expect(result.ok).toBe(true);
  expect(existsSync(taskFile)).toBe(true);
  expect(existsSync(workspaceFile)).toBe(true);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test apps/sidecar/src/services/agent/agent-file-promotion-service.test.ts`
Expected: FAIL with missing service

- [ ] **Step 3: 实现最小复制提升**

```ts
copyFileSync(sourcePath, targetPath);
return { ok: true, path: targetPath };
```

- [ ] **Step 4: 增加冲突处理测试**

```ts
test("共享层同名文件存在时应拒绝静默覆盖", async () => {
  await expect(promoteFileToWorkspace(...)).rejects.toThrow("同名文件已存在");
});
```

- [ ] **Step 5: 实现冲突处理**

```ts
if (existsSync(targetPath) && conflictMode !== "overwrite") {
  throw new Error("同名文件已存在");
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `bun test apps/sidecar/src/services/agent/agent-file-promotion-service.test.ts`
Expected: PASS

- [ ] **Step 7: 将 handler 接到服务**

```ts
return promoteFileToWorkspace(validateInput(...));
```

- [ ] **Step 8: Commit**

```bash
git add apps/sidecar/src/services/agent/agent-file-promotion-service.ts apps/sidecar/src/services/agent/agent-file-promotion-service.test.ts apps/sidecar/src/services/agent/agent-files-service.ts apps/sidecar/src/rpc/agent-handlers.ts
git commit -m "feat: ✨实现任务文件提升到共享层服务"
```

### Task 6: 将推荐卡片接到真实文件数据

**Files:**
- Modify: `D:/workspace/projects/ai-projects/lume/apps/web/components/agent/AgentView.tsx`
- Modify: `D:/workspace/projects/ai-projects/lume/apps/web/components/agent/AgentMessages.tsx`
- Modify: `D:/workspace/projects/ai-projects/lume/apps/web/components/agent/FilePromotionCard.tsx`

- [ ] **Step 1: 写失败测试，卡片应接受真实文件候选列表**

```tsx
test("提升后文件状态应更新为已提升", () => {
  ...
  expect(html).toContain("已提升");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test apps/web/components/agent/file-promotion-card.test.tsx`
Expected: FAIL with missing promoted state rendering

- [ ] **Step 3: 在 AgentView 中引入 promotionFiles 状态**

```ts
const [promotionFiles, setPromotionFiles] = React.useState<PromotionCandidate[]>([]);
```

- [ ] **Step 4: 在任务完成后筛选当前任务文件候选**

```ts
if (!streaming && sessionSwitching === false) {
  // 从 thread root 文件列表中过滤新增候选
}
```

- [ ] **Step 5: 将卡片渲染接到 onPromote / onDismiss**

```tsx
<FilePromotionCard
  files={promotionFiles}
  onPromote={(file) => void handlePromote(file)}
  onDismiss={() => setPromotionFiles([])}
/>
```

- [ ] **Step 6: 调用 desktop-api 提升并更新状态**

```ts
await promoteFileToWorkspace(...);
setPromotionFiles((prev) => prev.map(...status: "promoted"));
```

- [ ] **Step 7: 运行 smoke**

Run: `bun run --filter @lume/web test:smoke`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add apps/web/components/agent/AgentView.tsx apps/web/components/agent/AgentMessages.tsx apps/web/components/agent/FilePromotionCard.tsx
git commit -m "feat: ✨接通任务完成后的文件提升推荐"
```

### Task 7: 扩展恢复与回归验证

**Files:**
- Modify: `D:/workspace/projects/ai-projects/lume/apps/sidecar/scripts/smoke-restart-restore.mjs`
- Modify: `D:/workspace/projects/ai-projects/lume/package.json`

- [ ] **Step 1: 为提升后状态补 smoke 断言**

```js
assert(restoredState.currentAgentThreadId === thread.id, "thread restore failed");
```

- [ ] **Step 2: 为共享层提升新增 smoke 场景**

```js
await sidecar.call("agent:promote-file-to-workspace", ...);
assert(workspaceFiles.some((item) => item.name === "report.md"), "promotion failed");
```

- [ ] **Step 3: 运行 smoke**

Run: `bun run smoke:core`
Expected: PASS with `SMOKE_RESTART_RESTORE_OK`

- [ ] **Step 4: Commit**

```bash
git add apps/sidecar/scripts/smoke-restart-restore.mjs package.json
git commit -m "test: ✅补齐文件提升与恢复回归 smoke"
```

### Task 8: 创建 Lume 自我进化 skill

**Files:**
- Create: `D:/workspace/projects/ai-projects/lume/apps/sidecar/default-skills/lume-file-governance/SKILL.md`
- Modify: `D:/workspace/projects/ai-projects/lume/apps/sidecar/src/services/system/default-skills-seeder.ts`

- [ ] **Step 1: 写 skill 文本初稿**

```md
# Lume 文件治理

## 核心原则
- 当前任务文件是任务私有产物
- 工作区共享文件是长期复用资料
- 外部附加目录是临时上下文
```

- [ ] **Step 2: 将“显式提升”与“推荐沉淀”规则写入 skill**

```md
- 不自动把任务产物迁移到共享层
- 任务完成后，应优先推荐用户显式提升
```

- [ ] **Step 3: 在 seeder 中注册默认 skill**

```ts
const DEFAULT_SKILLS = [
  ...,
  "lume-file-governance"
];
```

- [ ] **Step 4: 验证 skill 可被同步到默认工作区**

Run: `bun run --filter @lume/sidecar smoke:restart-restore`
Expected: PASS and default workspace still seeds successfully

- [ ] **Step 5: Commit**

```bash
git add apps/sidecar/default-skills/lume-file-governance/SKILL.md apps/sidecar/src/services/system/default-skills-seeder.ts
git commit -m "feat: ✨沉淀文件治理理念为 Lume 自我进化 skill"
```

---

## Self-Review

### Spec coverage

- 三层模型定义：Task 1
- 右侧面板布局与入口语义：Task 1、Task 2
- 推荐提升卡片：Task 3、Task 6
- 提升数据流与冲突处理：Task 4、Task 5
- 收尾 skill：Task 8

无 spec gap。

### Placeholder scan

- 未使用 `TODO` / `TBD`
- 每个任务都给出明确文件路径
- 每个代码步骤都包含最小代码块
- 每个验证步骤都包含命令与预期

### Type consistency

- 提升动作统一使用 `PromoteFileToWorkspaceInput`
- 前端方法名统一为 `promoteFileToWorkspace`
- sidecar service 名统一为 `agent-file-promotion-service`

---

Plan complete and saved to `docs/superpowers/plans/2026-04-11-lume-files-workspace-redesign.md`. Two execution options:

1. Subagent-Driven (recommended) - I dispatch a fresh subagent per task, review between tasks, fast iteration

2. Inline Execution - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
