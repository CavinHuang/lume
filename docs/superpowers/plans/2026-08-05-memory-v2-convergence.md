# Memory-v2 收敛实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Lume memory-v2 的 kind 分类从 9 种收敛为 4 种（profile/workflow/voice/instruction），使 UI 分类由 kind 直接驱动，并添加 post-run 自动提取和新鲜度管理 UI。

**Architecture:** 在 `packages/shared` 收敛外部 `MemoryKind` 类型；在 sidecar `MemoryV2EntryFrontmatter` 加 `category` 字段存储外部分类；UI 分类逻辑改为读 `category`，废弃 tag-based 推断。autoCapture 在 `run-observer.ts` 的 `finalize("completed")` 后触发异步提取。

**Tech Stack:** TypeScript / Bun / bun:test / React 18 / Jotai / Tailwind

## Global Constraints

- 测试用 `bun test`，**不用** vitest
- 仓库用 bun@1.3.13（`bun install`，非 pnpm/npm）
- React 18.3.1（非 19）
- 不修改内部 `MemoryV2Kind`（保持 `preference|fact|decision|lesson|state` 5 种不变）
- 不直接往 `main` 推代码，所有改动在 worktree 分支上
- 旧数据向后兼容：无 `category` 字段的旧 entry 用 tag-based 回退推断分类
- 每个 Task 结束时提交（emoji 前缀，主题合并风格）

---

## 文件改动全览

| 文件 | 操作 | 说明 |
|------|------|------|
| `packages/shared/src/types/memory.ts` | 修改 | `MemoryKind` 9种→4种；新增 migration helper |
| `apps/sidecar/src/services/memory-v2/types.ts` | 修改 | `MemoryV2EntryFrontmatter` 加 `category?: string` |
| `apps/sidecar/src/services/memory-v2/tools.ts` | 修改 | `toMemoryV2Kind` 映射；写入时填 `category` |
| `apps/sidecar/src/services/memory-v2/extraction.ts` | 修改 | `inferKind` 使用新4种 kind |
| `apps/sidecar/src/services/memory-v2/markdown-store.ts` | 修改 | `writeEntry` 写 `category`；`updateEntry` 支持 `valid_to` + status |
| `apps/sidecar/src/services/memory-v2/retrieval.ts` | 修改 | `kindIntentBoost` 映射适配新4种 |
| `apps/sidecar/src/services/agent/prompt/sections/memory-sections.ts` | 修改 | kind 使用指引说明新4种 |
| `apps/sidecar/src/services/memory-v2/auto-capture.ts` | 新建 | post-run 自动提取服务 |
| `apps/sidecar/src/services/agent-runtime/runner/run-observer.ts` | 修改 | `finalize("completed")` 后触发 autoCapture |
| `apps/sidecar/src/services/memory-v2/policy.ts` | 修改 | `MemoryRuntimeConfig` 加 `autoCapture` 字段 |
| `packages/shared/src/types/memory.ts` | 修改（继续）| `MemoryRuntimeConfig` 加 `autoCapture`；`UpdateMemoryEntryInput` 加 `valid_to`/`status` |
| `apps/web/src/components/settings/memory-settings-state.ts` | 修改 | `MEMORY_KIND_LABELS`；`classifyMemoryEntryLayer` 改为 kind-driven |
| `apps/web/src/components/settings/MemorySettings.tsx` | 修改 | autoCapture toggle；valid_to 日期选择；stale 按钮 |

---

## Task 1：Kind 分类收敛（shared 类型 + sidecar 写入路径）

**Files:**
- Modify: `packages/shared/src/types/memory.ts`
- Modify: `apps/sidecar/src/services/memory-v2/types.ts`
- Modify: `apps/sidecar/src/services/memory-v2/tools.ts`
- Modify: `apps/sidecar/src/services/memory-v2/extraction.ts`
- Modify: `apps/sidecar/src/services/memory-v2/markdown-store.ts`
- Test: `apps/sidecar/src/services/memory-v2/tools.test.ts`
- Test: `apps/sidecar/src/services/memory-v2/extraction.test.ts`

**Interfaces:**
- Produces: `MemoryKind = "profile" | "workflow" | "voice" | "instruction"`（后续所有 Task 共用）
- Produces: `migrateMemoryKind(oldKind, tags) => MemoryKind`（UI Task 用于展示旧 entry）
- Produces: 写入的每条新 entry 的 YAML frontmatter 含 `category: "profile"|"workflow"|"voice"|"instruction"`

- [ ] **Step 1：更新 `packages/shared/src/types/memory.ts` 中的 `MemoryKind`**

把9种替换为4种，保留 `LegacyMemoryKind` 供迁移用：

```ts
// packages/shared/src/types/memory.ts

// 新的4种外部分类——与 UI 分类1:1对应
export type MemoryKind =
  | "profile"      // 身份画像：名字、角色、稳定个人信息
  | "workflow"     // 工作方式：偏好、决策、项目约定、状态
  | "voice"        // 写作风格：文风、语气、格式偏好
  | "instruction"; // 用户指令：规则、事实源、长期约束

// 仅用于迁移——不在新代码中使用
export type LegacyMemoryKind =
  | "raw" | "summary" | "fact" | "preference"
  | "decision" | "episode" | "lesson" | "milestone" | "artifact";

export function migrateMemoryKind(
  oldKind: string,
  tags: string[],
): MemoryKind {
  const tagSet = new Set(tags.map((t) => t.toLowerCase()));
  if (tagSet.has("profile") || tagSet.has("identity") || tagSet.has("preferred-name")) return "profile";
  if (tagSet.has("voice") || tagSet.has("writing-style")) return "voice";
  if (tagSet.has("instruction") || tagSet.has("rule") || tagSet.has("global-memory")) return "instruction";
  if (oldKind === "preference") return "workflow";
  if (oldKind === "lesson" || oldKind === "artifact") return "instruction";
  if (oldKind === "decision" || oldKind === "raw" || oldKind === "summary"
      || oldKind === "episode" || oldKind === "milestone") return "workflow";
  // fact — 用 claim predicate 或 scope 区分
  if (oldKind === "fact") return "instruction"; // conservative: rules/constraints are facts
  return "workflow"; // fallback
}
```

- [ ] **Step 2：给 `MemoryV2EntryFrontmatter` 加 `category` 字段**

```ts
// apps/sidecar/src/services/memory-v2/types.ts
export interface MemoryV2EntryFrontmatter {
  // ... 现有字段不变 ...
  valid_from: string | null;
  valid_to: string | null;
  claim?: MemoryV2Claim;
  activation?: MemoryV2Activation;
  /** 外部显示分类（profile/workflow/voice/instruction）。新 entry 写入；旧 entry 无此字段时 UI 回退 tag-based 推断。 */
  category?: string;
}
```

- [ ] **Step 3：更新 `tools.ts` 的 `toMemoryV2Kind` 映射**

```ts
// apps/sidecar/src/services/memory-v2/tools.ts

function toMemoryV2Kind(kind?: string): MemoryV2Kind {
  if (kind === "profile") return "fact";        // 身份事实
  if (kind === "voice") return "preference";    // 风格偏好
  if (kind === "instruction") return "fact";    // 规则即事实
  if (kind === "workflow") return "state";      // 工作状态/决策
  // 旧 kind 回退（向后兼容）
  if (kind === "preference") return "preference";
  if (kind === "decision" || kind === "lesson") return "lesson";
  return "fact"; // raw/summary/episode/milestone/artifact → fact
}

function fromMemoryV2Kind(kind: MemoryV2Kind): MemorySearchResult["kind"] {
  // 新代码写入 category 字段；此函数仅处理无 category 的旧数据
  if (kind === "preference") return "voice";
  if (kind === "lesson") return "instruction";
  if (kind === "state") return "workflow";
  if (kind === "decision") return "workflow";
  return "instruction"; // fact → instruction（保守）
}
```

同时在 `normalizeRememberCandidate` 中传入 `category`：

```ts
function normalizeRememberCandidate(
  input: MemoryRememberToolInput,
  fallbackScope: MemoryV2Scope,
  fallbackKind: MemoryV2Kind,
): MemoryV2Candidate & { category?: string } {
  // 现有逻辑不变，末尾加：
  return {
    // ... existing fields ...
    category: isNewMemoryKind(input.kind) ? input.kind : undefined,
  };
}

function isNewMemoryKind(kind?: string): kind is "profile"|"workflow"|"voice"|"instruction" {
  return kind === "profile" || kind === "workflow" || kind === "voice" || kind === "instruction";
}
```

- [ ] **Step 4：更新 `extraction.ts` 的 `inferKind`**

```ts
// apps/sidecar/src/services/memory-v2/extraction.ts
// inferKind 仍返回 MemoryV2Kind（内部），但用语义更清晰的逻辑
function inferKind(text: string, statement: string): MemoryV2Kind {
  const combined = `${text}\n${statement}`.toLowerCase();
  if (/prefer|以后|喜欢|偏好|默认|习惯|风格|语气|文风/.test(combined)) return "preference";
  if (/actually|不对|错了|correction|correct|规则|rule|约束|事实源|source of truth/.test(combined)) return "fact";
  if (/决定|决策|decision|选择|chosen/.test(combined)) return "decision";
  return "fact";
}
```

- [ ] **Step 5：更新 `markdown-store.ts` 的 `writeEntry`，写入 `category`**

`MemoryV2Candidate` 目前无 `category` 字段，需要通过 `writeEntry` 的 input 参数传入：

```ts
// apps/sidecar/src/services/memory-v2/markdown-store.ts
export function writeEntry(candidate: MemoryV2Candidate, input: {
  status?: MemoryV2Status;
  pinned?: boolean;
  related?: string[];
  supersedes?: string[];
  source?: MemoryV2Source;
  activation?: MemoryV2Activation;
  category?: string; // 新增
} = {}): MemoryV2Entry {
  // ...existing logic...
  const frontmatter: MemoryV2EntryFrontmatter = {
    // ...existing fields...
    ...(input.category ? { category: input.category } : {}),
  };
  // ...rest unchanged...
}
```

在 `tools.ts` 的 `rememberMemoryTool` 里把 category 传入 `writeEntry` 调用链（通过 `smartAddMemoryV2Candidate` → `writeEntry`）：暂时在 `smartAddMemoryV2Candidate` 的入参里加 `category?: string`，透传到 `writeEntry`。

- [ ] **Step 6：为 `toMemoryV2Kind` 写测试**

```ts
// apps/sidecar/src/services/memory-v2/tools.test.ts
import { describe, test, expect } from "bun:test";
import { toMemoryV2Kind } from "./tools"; // export it for testing

describe("toMemoryV2Kind", () => {
  test("profile → fact", () => expect(toMemoryV2Kind("profile")).toBe("fact"));
  test("voice → preference", () => expect(toMemoryV2Kind("voice")).toBe("preference"));
  test("instruction → fact", () => expect(toMemoryV2Kind("instruction")).toBe("fact"));
  test("workflow → state", () => expect(toMemoryV2Kind("workflow")).toBe("state"));
  test("旧 preference 向后兼容", () => expect(toMemoryV2Kind("preference")).toBe("preference"));
  test("undefined fallback → fact", () => expect(toMemoryV2Kind(undefined)).toBe("fact"));
});
```

- [ ] **Step 7：运行测试，确认通过**

```bash
cd apps/sidecar && bun test src/services/memory-v2/tools.test.ts --reporter=dot
```

Expected: 全部 PASS

- [ ] **Step 8：为 `migrateMemoryKind` 写测试**

```ts
// packages/shared/src/types/memory.test.ts（如不存在则新建）
import { describe, test, expect } from "bun:test";
import { migrateMemoryKind } from "./memory";

describe("migrateMemoryKind", () => {
  test("带 profile tag → profile", () =>
    expect(migrateMemoryKind("fact", ["profile"])).toBe("profile"));
  test("带 voice tag → voice", () =>
    expect(migrateMemoryKind("preference", ["voice"])).toBe("voice"));
  test("带 instruction tag → instruction", () =>
    expect(migrateMemoryKind("fact", ["instruction"])).toBe("instruction"));
  test("lesson 无 tag → instruction", () =>
    expect(migrateMemoryKind("lesson", [])).toBe("instruction"));
  test("preference 无 tag → workflow", () =>
    expect(migrateMemoryKind("preference", [])).toBe("workflow"));
  test("未知 kind 无 tag → workflow", () =>
    expect(migrateMemoryKind("unknown", [])).toBe("workflow"));
});
```

- [ ] **Step 9：运行测试**

```bash
cd packages/shared && bun test --reporter=dot
```

- [ ] **Step 10：运行全量 sidecar 测试确认不回退**

```bash
cd apps/sidecar && bun test --reporter=dot 2>&1 | tail -20
```

- [ ] **Step 11：提交**

```bash
git add packages/shared/src/types/memory.ts \
  apps/sidecar/src/services/memory-v2/types.ts \
  apps/sidecar/src/services/memory-v2/tools.ts \
  apps/sidecar/src/services/memory-v2/extraction.ts \
  apps/sidecar/src/services/memory-v2/markdown-store.ts \
  apps/sidecar/src/services/memory-v2/smart-add.ts
git commit -m "♻️ refactor(memory): kind 分类收敛 9→4（profile/workflow/voice/instruction）+ category 字段"
```
