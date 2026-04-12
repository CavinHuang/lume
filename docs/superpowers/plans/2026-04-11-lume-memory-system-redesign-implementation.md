# Lume Memory System Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Lume’s current mixed memory model with a clean three-layer memory system built around `~/.lume/MEMORY.md`, `<workspace>/MEMORY.md`, `<workspace>/memory/YYYY-MM-DD.md`, and thread `.context`, while removing old recall/save/indexing behavior so only the new memory model remains.

**Architecture:** Keep Markdown files as the truth layer and sqlite/embedding as a derived index layer. Rewrite path rules, save flow, recall order, and indexing sources to match the new memory layout. Long-term memory updates must be driven by a sidecar-internal LLM distillation service with structured outputs; no rule-based distillation path should remain in the final design.

**Tech Stack:** Bun, TypeScript strict, sidecar memory services, sqlite (`bun:sqlite`), workspace file layout helpers, shared memory contracts.

---

## File Structure

### New Files

- `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\memory\memory-distillation-service.ts`
  - LLM-driven distillation service that reads a bounded memory window and returns structured workspace/global additions.
- `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\memory\memory-distillation-service.test.ts`
  - Distillation tests.

### Modified Files

- `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\infra\config-paths.ts`
  - Add global memory paths and global memory sqlite path.
- `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\memory\memory-path-utils.ts`
  - Redefine valid memory paths for global/workspace/thread memory.
- `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\memory\memory-policy.ts`
  - Align recall source order and source model.
- `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\memory\memory-service.ts`
  - Provide layered memory read/search/write/index helpers for workspace + global memory.
- `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\memory\memory-index-manager.ts`
  - Reindex only new memory truth paths, remove legacy assumptions.
- `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\memory\memory-mcp-service.ts`
  - Update tool descriptions and behavior to the new memory model.
- `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\memory\memory-sync-watcher.ts`
  - Watch new memory files only.
- `D:\workspace\projects\ai-projects\lume\packages\shared\src\types\memory.ts`
  - Add new path semantics and distillation input/output contracts if needed.
- `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\agent\agent-prompt-builder.ts`
  - Update prompt text so agent only sees the new memory structure.
- `D:\workspace\projects\ai-projects\lume\apps\sidecar\scripts\smoke-restart-restore.mjs`
  - Optional final smoke for the new memory layout.

### Tests To Update

- `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\memory\memory-path-utils.test.ts`
- `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\memory\memory-service.test.ts`
- `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\memory\memory-mcp-service.test.ts`
- `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\memory\memory-policy.test.ts`
- `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\memory\memory-index-manager.test.ts`
- `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\memory\memory-extra-paths.test.ts`
- `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\agent\agent-prompt-builder.test.ts`

---

### Task 1: Lock In The New Memory Paths And Remove Legacy Path Semantics

**Files:**
- Modify: `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\infra\config-paths.ts`
- Modify: `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\memory\memory-path-utils.ts`
- Modify: `D:\workspace\projects\ai-projects\lume\packages\shared\src\types\memory.ts`
- Test: `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\infra\config-paths.test.ts`
- Test: `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\memory\memory-path-utils.test.ts`

- [ ] **Step 1: Write the failing path tests**

```ts
import { expect, test } from "bun:test";
import {
  getWorkspaceLongTermMemoryPath,
  getWorkspaceMemoryDbPath,
  getGlobalMemoryPath,
  getGlobalMemoryDbPath
} from "../infra/config-paths";
import { isMemoryPath } from "./memory-path-utils";

test("全局与 workspace 记忆路径应符合新结构", () => {
  expect(getGlobalMemoryPath().replace(/\\/g, "/")).toContain("/.lume/MEMORY.md");
  expect(getGlobalMemoryDbPath().replace(/\\/g, "/")).toContain("/.lume/.meta/memory.sqlite");
  expect(getWorkspaceLongTermMemoryPath("demo").replace(/\\/g, "/")).toContain("/agent-workspaces/demo/MEMORY.md");
  expect(getWorkspaceMemoryDbPath("demo").replace(/\\/g, "/")).toContain("/agent-workspaces/demo/.meta/memory.sqlite");
});

test("isMemoryPath 只接受 MEMORY.md 和 memory/YYYY-MM-DD.md", () => {
  expect(isMemoryPath("MEMORY.md")).toBe(true);
  expect(isMemoryPath("memory/2026-04-11.md")).toBe(true);
  expect(isMemoryPath("memory/daily/2026-04-11.md")).toBe(false);
  expect(isMemoryPath("memory.md")).toBe(false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
bun test D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\infra\config-paths.test.ts
bun test D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\memory\memory-path-utils.test.ts
```

Expected: FAIL because global memory helpers do not exist and old path rules still allow legacy shapes.

- [ ] **Step 3: Add new path helpers**

```ts
// apps/sidecar/src/services/infra/config-paths.ts
export function getGlobalMemoryPath(): string {
  return join(getConfigDir(), "MEMORY.md");
}

export function getGlobalMetaDir(): string {
  return ensureDir(join(getConfigDir(), ".meta"), "全局元数据目录");
}

export function getGlobalMemoryDbPath(): string {
  return join(getGlobalMetaDir(), "memory.sqlite");
}
```

- [ ] **Step 4: Remove old memory path semantics**

```ts
// apps/sidecar/src/services/memory/memory-path-utils.ts
export function isMemoryPath(relPath: string): boolean {
  const normalized = normalizeRelPath(relPath);
  if (normalized === "MEMORY.md") return true;
  return /^memory\/\d{4}-\d{2}-\d{2}\.md$/i.test(normalized);
}
```

- [ ] **Step 5: Update shared memory comments to the new meaning**

```ts
// packages/shared/src/types/memory.ts
/** path: "MEMORY.md" for workspace long-term memory, or "memory/YYYY-MM-DD.md" for short-term daily memory */
```

- [ ] **Step 6: Run tests and sidecar typecheck**

Run:

```bash
bun test D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\infra\config-paths.test.ts
bun test D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\memory\memory-path-utils.test.ts
cd D:\workspace\projects\ai-projects\lume\apps\sidecar
bun run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/sidecar/src/services/infra/config-paths.ts apps/sidecar/src/services/infra/config-paths.test.ts apps/sidecar/src/services/memory/memory-path-utils.ts apps/sidecar/src/services/memory/memory-path-utils.test.ts packages/shared/src/types/memory.ts
git commit -m "refactor(memory): ♻️收口全局与 workspace 记忆路径模型"
```

### Task 2: Rewrite Memory Save Flow To Match The New Truth Layer

**Files:**
- Modify: `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\memory\memory-index-manager.ts`
- Modify: `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\memory\memory-service.ts`
- Test: `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\memory\memory-save.test.ts`
- Test: `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\memory\memory-service.test.ts`

- [ ] **Step 1: Write the failing save tests**

```ts
test("未指定 path 时应写入 workspace memory/YYYY-MM-DD.md", async () => {
  const result = await writeWorkspaceMemory({
    workspaceSlug: "demo",
    content: "short term memory",
    date: "2026-04-11"
  });
  expect(result.path).toBe("memory/2026-04-11.md");
});

test("指定 path=MEMORY.md 时应追加到 workspace 长期记忆", async () => {
  const result = await writeWorkspaceMemory({
    workspaceSlug: "demo",
    content: "stable workspace memory",
    path: "MEMORY.md"
  });
  expect(result.path).toBe("MEMORY.md");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
bun test D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\memory\memory-save.test.ts
bun test D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\memory\memory-service.test.ts
```

Expected: FAIL if legacy `memory.md` behavior is still accepted.

- [ ] **Step 3: Remove legacy `memory.md` writes and unify save rules**

```ts
// apps/sidecar/src/services/memory/memory-index-manager.ts
if (input.path === "MEMORY.md") {
  relativePath = "MEMORY.md";
} else {
  const safeDate = validateDate(input.date);
  relativePath = `memory/${safeDate}.md`;
}
```

- [ ] **Step 4: Keep short-term writes timestamped but compact**

```ts
const block = `\n## ${new Date().toISOString()}\n${trimmed}\n`;
appendFileSync(absolutePath, block, "utf-8");
```

- [ ] **Step 5: Run save tests**

Run:

```bash
bun test D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\memory\memory-save.test.ts
bun test D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\memory\memory-service.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/sidecar/src/services/memory/memory-index-manager.ts apps/sidecar/src/services/memory/memory-service.ts apps/sidecar/src/services/memory/memory-save.test.ts apps/sidecar/src/services/memory/memory-service.test.ts
git commit -m "refactor(memory): ♻️重写记忆写入流转到短期层与长期层"
```

### Task 3: Rewrite Recall And Index Source Ordering

**Files:**
- Modify: `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\memory\memory-policy.ts`
- Modify: `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\memory\memory-index-manager.ts`
- Modify: `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\memory\memory-sync-watcher.ts`
- Test: `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\memory\memory-policy.test.ts`
- Test: `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\memory\memory-index-manager.test.ts`

- [ ] **Step 1: Write the failing recall-order tests**

```ts
test("默认 sources 应优先围绕 workspace 记忆，而不是旧 memory.md 兼容路径", () => {
  const config = resolveMemoryRuntimeConfig();
  expect(config.sources).toContain("memory");
});

test("indexWorkspace 只应采集 MEMORY.md 与 memory/YYYY-MM-DD.md", async () => {
  // create demo/MEMORY.md, demo/memory/2026-04-11.md, demo/memory.md
  const count = await manager.indexWorkspace(true);
  expect(count).toBe(2);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
bun test D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\memory\memory-policy.test.ts
bun test D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\memory\memory-index-manager.test.ts
```

Expected: FAIL because old memory file shapes are still indexed.

- [ ] **Step 3: Remove old file collection rules**

```ts
// memory-path-utils.ts
// No more "memory.md" fallback.

// memory-index-manager.ts
// collectWorkspaceMemoryEntries must only include:
// - MEMORY.md
// - memory/YYYY-MM-DD.md
```

- [ ] **Step 4: Ensure watcher only watches new memory truth paths**

```ts
// memory-sync-watcher.ts
// Ignore legacy memory.md and daily/ subfolder assumptions.
```

- [ ] **Step 5: Run memory indexing tests**

Run:

```bash
bun test D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\memory\memory-index-manager.test.ts
bun test D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\memory\memory-policy.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/sidecar/src/services/memory/memory-policy.ts apps/sidecar/src/services/memory/memory-policy.test.ts apps/sidecar/src/services/memory/memory-index-manager.ts apps/sidecar/src/services/memory/memory-index-manager.test.ts apps/sidecar/src/services/memory/memory-sync-watcher.ts
git commit -m "refactor(memory): ♻️对齐新的 recall 顺序与索引来源"
```

### Task 4: Add Global Memory As A First-Class Layer

**Files:**
- Modify: `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\memory\memory-service.ts`
- Modify: `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\memory\memory-mcp-service.ts`
- Test: `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\memory\memory-mcp-service.test.ts`

- [ ] **Step 1: Write the failing global-memory tests**

```ts
test("memory_get 应允许读取 ~/.lume/MEMORY.md 作为全局长期记忆", () => {
  const result = readLayeredMemoryFile({ workspaceSlug: "demo", path: "~/.lume/MEMORY.md" });
  expect(result.path).toContain("MEMORY.md");
});

test("memory_search 结果说明应体现全局与 workspace 记忆分层", async () => {
  const server = buildMemoryMcpServer("demo", sdk, options);
  // assert tool description mentions workspace MEMORY.md and ~/.lume/MEMORY.md
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\memory\memory-mcp-service.test.ts`

Expected: FAIL because global memory layer is not exposed yet.

- [ ] **Step 3: Add global memory read/search support**

```ts
// memory-service.ts
export function readLayeredMemoryFile(...) { ... }
export function searchLayeredMemory(...) { ... }
```

- [ ] **Step 4: Update MCP tool descriptions**

```ts
// memory-mcp-service.ts
description:
  "Search current thread note, workspace daily memory, workspace MEMORY.md, and global ~/.lume/MEMORY.md in that order."
```

- [ ] **Step 5: Run MCP tests**

Run:

```bash
bun test D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\memory\memory-mcp-service.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/sidecar/src/services/memory/memory-service.ts apps/sidecar/src/services/memory/memory-mcp-service.ts apps/sidecar/src/services/memory/memory-mcp-service.test.ts
git commit -m "feat(memory): ✨新增全局 MEMORY 层并接入记忆工具"
```

### Task 5: Replace Rule Distillation With Sidecar LLM Distillation

**Files:**
- Create: `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\memory\memory-distillation-service.ts`
- Create: `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\memory\memory-distillation-service.test.ts`
- Modify: `D:\workspace\projects\ai-projects\lume\packages\shared\src\types\memory.ts`

- [ ] **Step 1: Write the failing distillation tests**

```ts
test("应通过 LLM 蒸馏返回结构化 workspace/global additions", async () => {
  // prepare recent memory files and inject fake llm result
  const result = await distillWorkspaceMemory({ workspaceSlug: "demo" });
  expect(result.updatedWorkspaceMemory).toBe(true);
  expect(result.promotedToGlobal).toContain("stable global preference");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\memory\memory-distillation-service.test.ts`

Expected: FAIL because the service does not exist.

- [ ] **Step 3: Implement sidecar-internal LLM distillation**

```ts
// memory-distillation-service.ts
export async function distillWorkspaceMemory(input: { workspaceSlug: string }) {
  // collect recent 7 daily memory files
  // collect recent 20 thread notes
  // read workspace MEMORY.md
  // read ~/.lume/MEMORY.md
  // call LLM with bounded window
  // parse structured JSON result:
  // { workspace_additions, global_additions, discarded_patterns, summary }
  // append deduped additions into workspace/global MEMORY.md
}
```

- [ ] **Step 4: Remove rule-based promotion logic**

```ts
// Delete any repeated-line threshold logic or "[global]" marker shortcut.
// Distillation decisions must come from the LLM result, not deterministic heuristics.
```

- [ ] **Step 5: Run tests**

Run:

```bash
bun test D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\memory\memory-distillation-service.test.ts
cd D:\workspace\projects\ai-projects\lume\apps\sidecar
bun run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/sidecar/src/services/memory/memory-distillation-service.ts apps/sidecar/src/services/memory/memory-distillation-service.test.ts packages/shared/src/types/memory.ts
git commit -m "feat(memory): ✨改为 sidecar 内部 LLM 记忆蒸馏"
```

### Task 6: Remove Old Memory Wording And Runtime Residue

**Files:**
- Modify: `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\agent\agent-prompt-builder.ts`
- Modify: `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\agent\agent-prompt-builder.test.ts`

- [ ] **Step 1: Write the failing prompt assertions**

```ts
test("prompt 应描述新的三层记忆模型，而不是旧 memory.md fallback", () => {
  const prompt = buildSystemPromptAppend({ ...ctx });
  expect(prompt).toContain("~/.lume/MEMORY.md");
  expect(prompt).toContain("memory/YYYY-MM-DD.md");
  expect(prompt).not.toContain("memory.md fallback");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\agent\agent-prompt-builder.test.ts`

Expected: FAIL because old wording is still present.

- [ ] **Step 3: Update prompt text**

```ts
// agent-prompt-builder.ts
lines.push("全局长期记忆: ~/.lume/MEMORY.md");
lines.push("workspace 长期记忆: <workspace>/MEMORY.md");
lines.push("workspace 短期记忆: <workspace>/memory/YYYY-MM-DD.md");
lines.push("thread 临时记忆: threads/<thread-id>/.context/note.md");
```

- [ ] **Step 4: Run prompt tests**

Run:

```bash
bun test D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\agent\agent-prompt-builder.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/sidecar/src/services/agent/agent-prompt-builder.ts apps/sidecar/src/services/agent/agent-prompt-builder.test.ts
git commit -m "refactor(memory): ♻️统一 prompt 中的记忆系统语义"
```

### Task 7: Final Cleanup And No-Residue Verification

**Files:**
- Modify: `D:\workspace\projects\ai-projects\lume\apps\sidecar\scripts\smoke-restart-restore.mjs`
- Test: all updated memory tests

- [ ] **Step 1: Add a smoke assertion for the new memory layout**

```js
// smoke-restart-restore.mjs
// write ~/.lume/MEMORY.md
// write workspace/MEMORY.md
// write workspace/memory/2026-04-11.md
// assert memory search/get only uses the new truth files
```

- [ ] **Step 2: Search for legacy residue**

Run:

```bash
Get-ChildItem -Recurse D:\workspace\projects\ai-projects\lume\apps\sidecar,D:\workspace\projects\ai-projects\lume\packages\shared -Include *.ts,*.tsx,*.md | Select-String -Pattern "memory.md fallback|daily/|memory\\.md"
```

Expected: no remaining references that imply the retired memory model, except intentionally migrated historical docs/tests updated for the new structure.

- [ ] **Step 3: Run full verification**

Run:

```bash
cd D:\workspace\projects\ai-projects\lume\apps\sidecar
bun run typecheck
bun test src/services/memory/*.test.ts src/services/agent/agent-prompt-builder.test.ts
cd D:\workspace\projects\ai-projects\lume
bun run smoke:core
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/sidecar/scripts/smoke-restart-restore.mjs
git commit -m "test(memory): ✅完成新记忆系统无残留校验"
```

---

## Self-Review

### Spec Coverage

- 三层记忆模型：Task 1, Task 2, Task 4
- 文件是真相源、索引是派生层：Task 2, Task 3
- 短期先写、长期晋升：Task 2, Task 5
- 全局 `~/.lume/MEMORY.md`：Task 1, Task 4
- 定期蒸馏任务：Task 5
- 全链路切换、无残留：Task 6, Task 7

### Placeholder Scan

- 无 `TODO` / `TBD`
- 所有任务有具体文件、测试、命令和最小代码示例

### Type Consistency

- 全局长期记忆统一为 `~/.lume/MEMORY.md`
- workspace 短期记忆统一为 `memory/YYYY-MM-DD.md`
- workspace 长期记忆统一为 `MEMORY.md`
- 不再保留 `memory.md` fallback 语义
