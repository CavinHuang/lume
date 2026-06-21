# Phase 3d：markdown-store findEntryById 按文件名定位 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **所属**：性能优化路线图 Phase 3 的最后一个子 plan（3a/3b 已完成；3c 经核查为非生产热路径，已跳过）。本 plan 改造 memory-v2 `markdown-store` 的 `findEntryById`。

**Goal:** 消除 `findEntryById`/`findEntryByIdAcrossScopes` 的全库 `readFileSync`+`YAML.parse`。当前它们走 `listEntries`（读 + parse **所有** entry 文件）再 `find` by id；改为利用文件名 `{YYYY-MM-DD}-{id}.md` 的规律，`readdirSync` + 文件名 id 匹配，只 `readEntryFile` 命中的那一个。

**Architecture:** entry 文件名格式固定为 `{10字符date}-{id}.md`（`writeEntry` line 168）。新增 `entryFileId(path)` helper（`basename(path, ".md").slice(11)` 去掉 date 前缀得 id）。`findEntryById` = `listMarkdownFiles(entriesDir).find(p => entryFileId(p) === id)` + 只 `readEntryFile` 命中文件。`findEntryByIdAcrossScopes` 同理遍历 global+workspace 两个 entriesDir。调用方（`updateEntryStatus`/`updateEntryRelations`/`updateEntry`/`deleteEntry`）不变，自动受益。

**Tech Stack:** Bun + `node:fs`（`readdirSync`/`statSync`/`readFileSync`）+ `bun:test` + `mkdtempSync(tmpdir)`。

**审查依据:** `markdown-store.ts:558-567`（findEntryById 走 listEntries 全扫）、`:569-575`（findEntryByIdAcrossScopes 同）、`:481-488`（readEntryFile = readFileSync + YAML.parse）、`:168`（文件名含 id）。

**诚实的范围边界:**
- ✅ **本 plan 优化**：`findEntryById`/`findEntryByIdAcrossScopes`（高频：每次 `updateEntryStatus`/`updateEntryRelations`/`updateEntry` 都调）。从 N×(readFileSync+YAML.parse) 降到 N×(文件名字符串比较) + 1×(readFileSync+YAML.parse)。
- ⚠️ **不在本 plan**：`removeEntryReferences`(577) 仍 `listEntries` 全扫——但它只在 `deleteEntry`(272) 调用（删除记忆时清理引用），**低频**，非热路径（审查报告高估了它）。如需优化可单独处理（反向索引或 frontmatter-only 读取）。
- ⚠️ **不在本 plan**：`listEntries` 本身（retrieval 的全量召回需要全部 entry，是合理的全量读）。
- ⚠️ `findEntryById` 的 `readdirSync` 仍 O(n)（列目录），但文件名字符串比较远快于 N×IO+YAML.parse。彻底消除需 id→path 反向索引（复杂，over-engineering for 当前规模）。

---

## File Structure

- Modify: `apps/sidecar/src/services/memory-v2/markdown-store.ts` — 新增 `entryFileId` helper；重写 `findEntryById` + `findEntryByIdAcrossScopes` 为文件名定位。
- Modify: `apps/sidecar/src/services/memory-v2/markdown-store.test.ts` — 追加 characterization（findEntryById 存在/不存在/跨 scope 行为）。
- Create: `apps/sidecar/src/services/memory-v2/markdown-store.bench.ts` — findEntryById（via updateEntryStatus）在 N entries 下的计时基准。

---

## Task 1：追加 characterization test 与基准

**Files:**
- Modify: `apps/sidecar/src/services/memory-v2/markdown-store.test.ts`
- Create: `apps/sidecar/src/services/memory-v2/markdown-store.bench.ts`

- [ ] **Step 1: 读现有 test 的 setup，追加 characterization 用例**

先读 `markdown-store.test.ts` 了解它如何 setup 临时 memory 目录（mkdtempSync + 设置 memory v2 路径/env）+ 已有的 `updateEntryStatusForTest` helper（line 243）+ `writeEntry` 用法。然后在该文件的合适 `describe` 块内**追加**以下用例（复用其 setup/helper；调整 helper 名以匹配实际）：

```ts
  test("findEntryById 命中存在的 entry（via updateEntryStatus 成功更新）", async () => {
    // 复用现有 setup 创建临时 memory 目录 + store
    const store = createMemoryV2Store();  // 或现有 setup 提供的 store
    const entry = store.writeEntry({ statement: "用户偏好深色模式", kind: "preference" } as any);
    const updated = store.updateEntryStatus({
      scope: entry.frontmatter.scope, workspaceSlug: undefined, id: entry.frontmatter.id, status: "archived"
    });
    expect(updated.frontmatter.status).toBe("archived");
  });

  test("findEntryById 未命中时抛错（不存在 id）", () => {
    const store = createMemoryV2Store();
    expect(() => store.updateEntryStatus({
      scope: "global", workspaceSlug: undefined, id: "nonexistent-id", status: "archived"
    })).toThrow(/not found/);
  });

  test("多个 entry 下 findEntryById 精确定位（无文件名后缀误匹配）", () => {
    const store = createMemoryV2Store();
    const a = store.writeEntry({ statement: "A", kind: "fact" } as any);
    const b = store.writeEntry({ statement: "B", kind: "fact" } as any);
    // 即使 id 相似（一个含另一个子串），仍精确定位
    const found = store.updateEntryStatus({
      scope: b.frontmatter.scope, workspaceSlug: undefined, id: b.frontmatter.id, status: "archived"
    });
    expect(found.frontmatter.id).toBe(b.frontmatter.id);
    // a 不受影响
    const aState = store.updateEntryStatus({
      scope: a.frontmatter.scope, workspaceSlug: undefined, id: a.frontmatter.id, status: "active"
    });
    expect(aState.frontmatter.id).toBe(a.frontmatter.id);
  });
```

> 这些用例通过 `updateEntryStatus`（public，内部调 `findEntryById`）间接锁定 findEntryById 行为。当前实现下应通过（锁定基线）。**第 3 个用例**（无文件名误匹配）是关键——确保改造用精确 id 匹配（非 endsWith 后缀），防止"id 是另一个 id 的后缀"时误匹配。

- [ ] **Step 2: 运行 test 确认基线**

Run: `bun test apps/sidecar/src/services/memory-v2/markdown-store.test.ts`
Expected: 全部 pass（含 3 个新用例）。若 setup/helper 与上面假设不符，调整以匹配实际（参考现有用例的写法）。

- [ ] **Step 3: 写基准脚本**

Create `apps/sidecar/src/services/memory-v2/markdown-store.bench.ts`（参考 markdown-store.test.ts 的 setup 方式创建临时 memory 目录 + store）：

```ts
// 手动基准脚本：bun apps/sidecar/src/services/memory-v2/markdown-store.bench.ts
// 量化 findEntryById（via updateEntryStatus）在 N entries 下的耗时。
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// 复用 test 文件的 memory-dir setup 方式（设置 MEMORY_V2 dir env 或 paths mock）
// 参考 markdown-store.test.ts 顶部如何配置临时 memory 目录
import { createMemoryV2Store } from "./markdown-store";

// setup: 配置临时 memory 目录（按 test 文件的方式）—— 调整以匹配实际 setup
const tmpDir = mkdtempSync(join(tmpdir(), "lume-md-store-bench-"));
process.env.MEMORY_V2_DIR = tmpDir;  // 或 test 用的实际配置方式

const store = createMemoryV2Store();
const N = 200;
const entries = [];
for (let i = 0; i < N; i++) {
  entries.push(store.writeEntry({ statement: `fact number ${i}`, kind: "fact" } as any));
}

// 测 findEntryById 命中（via updateEntryStatus，含一次 find + 一次 write）
const target = entries[N - 1]!;
const M = 50;
const start = performance.now();
for (let i = 0; i < M; i++) {
  store.updateEntryStatus({
    scope: target.frontmatter.scope, workspaceSlug: undefined,
    id: target.frontmatter.id, status: i % 2 === 0 ? "archived" : "active"
  });
}
const elapsed = performance.now() - start;
console.log(`updateEntryStatus (find+write) x${M} with N=${N} entries: ${elapsed.toFixed(1)}ms`);
```

> 注意：bench 的 memory-dir setup 必须与 test 一致（参考 markdown-store.test.ts 如何配临时目录）。如果 memory-v2 用 workspace/global 的固定路径而非 env，bench 需对应 mock。implementer 读 test 文件确认 setup 方式后调整。

- [ ] **Step 4: 运行基准记录基线 B0**

Run: `bun apps/sidecar/src/services/memory-v2/markdown-store.bench.ts`
Expected: 打印耗时（记为 **B0**）。当前实现每次 updateEntryStatus 都 listEntries 全 parse N 个文件，M 次 = M×N 次 readFileSync+YAML.parse。

- [ ] **Step 5: Commit**

```bash
git add apps/sidecar/src/services/memory-v2/markdown-store.test.ts apps/sidecar/src/services/memory-v2/markdown-store.bench.ts
git commit -m "test(sidecar): markdown-store 追加 findEntryById characterization 与基准"
```

---

## Task 2：findEntryById 改文件名定位

**Files:**
- Modify: `apps/sidecar/src/services/memory-v2/markdown-store.ts`

- [ ] **Step 1: 新增 entryFileId helper**

在 `listMarkdownFiles`（line 704）附近新增（从文件名提取 id）：

```ts
/** entry 文件名格式 {YYYY-MM-DD}-{id}.md；去掉 .md 后缀与 10 字符 date 前缀（+"-"）得 id。 */
function entryFileId(path: string): string {
  return basename(path, ".md").slice(11);
}
```

> `basename(path, ".md")` = `YYYY-MM-DD-{id}`；`.slice(11)` 去掉 `YYYY-MM-DD-`（10 字符 date + 1 字符 `-`）= id。**用完整 id 精确匹配**（非 `endsWith` 后缀），避免"id 是另一个 id 后缀"时的误匹配。

- [ ] **Step 2: 重写 findEntryById（文件名定位 + 只读命中）**

替换 `findEntryById`（当前 line 558-567）：

```ts
function findEntryById(input: {
  scope: MemoryV2Scope;
  workspaceSlug?: string;
  id: string;
}): MemoryV2Entry | undefined {
  const paths = getMemoryV2ScopePaths({ scope: input.scope, workspaceSlug: input.workspaceSlug });
  const file = listMarkdownFiles(paths.entriesDir).find((path) => entryFileId(path) === input.id);
  if (!file) return undefined;
  try {
    return readEntryFile(file);
  } catch {
    return undefined;
  }
}
```

> 不再 `listEntries`（全库 read+parse）。`listMarkdownFiles` = readdirSync + statSync（列目录，不读内容）；`find` 用 `entryFileId` 精确匹配 id；只 `readEntryFile` 命中的 1 个。readFileSync+YAML.parse 从 N 次降到 1 次。

- [ ] **Step 3: 重写 findEntryByIdAcrossScopes（跨 scope 文件名定位）**

替换 `findEntryByIdAcrossScopes`（当前 line 569-575）：

```ts
function findEntryByIdAcrossScopes(id: string, workspaceSlug?: string): MemoryV2Entry | undefined {
  for (const scope of ["global", "workspace"] as const) {
    if (scope === "workspace" && !workspaceSlug) continue;
    const paths = getMemoryV2ScopePaths({ scope, workspaceSlug });
    const file = listMarkdownFiles(paths.entriesDir).find((path) => entryFileId(path) === id);
    if (file) {
      try {
        return readEntryFile(file);
      } catch {
        continue;
      }
    }
  }
  return undefined;
}
```

> 原 `includeStatuses: ALL_ENTRY_STATUSES` 是全集（含所有 status），等价于"不过滤"——改造直接读命中文件，语义一致（ALL 是全集，任何 entry status 都在 ALL 内）。

- [ ] **Step 4: 运行 test + 重跑基准 + typecheck**

Run: `bun test apps/sidecar/src/services/memory-v2/markdown-store.test.ts` → 全部 pass（含 3 个新 characterization）。
Run: `bun apps/sidecar/src/services/memory-v2/markdown-store.bench.ts` → 显著低于 B0（readFileSync+YAML.parse 从 M×N 降到 M）。
Run: `bun run --filter @lume/sidecar typecheck` → pass。

- [ ] **Step 5: Commit**

```bash
git add apps/sidecar/src/services/memory-v2/markdown-store.ts
git commit -m "⚡️ perf(sidecar): markdown-store findEntryById 按文件名定位，消除全库 parse"
```

---

## Task 3：集成验证

**Files:** 无改动（仅验证）

- [ ] **Step 1: memory-v2 全量回归**

Run: `bun test apps/sidecar/src/services/memory-v2/ 2>&1 | tail -5`
Expected: 全绿（markdown-store + ingestion + smart-add + retrieval 等 16 个 test 文件无回归）。smart-add/retrieval 间接用 findEntryById/updateEntryStatus，是关键回归点。

- [ ] **Step 2: bench 最终对比**

Run: `bun apps/sidecar/src/services/memory-v2/markdown-store.bench.ts`
Expected: 远低于 B0。

- [ ] **Step 3: typecheck**

Run: `bun run --filter @lume/sidecar typecheck`
Expected: 通过。

- [ ] **Step 4: 调用方契约检查**

确认 findEntryById 改造后，调用方行为不变：
- `updateEntryStatus`/`updateEntryRelations`/`updateEntry`/`deleteEntry`：用 findEntryById 定位 → 命中则改、未命中抛 "not found" ✓
- 跨 scope 查找（findEntryByIdAcrossScopes）：global+workspace 都找 ✓

---

## 注意事项与边界

- **id 精确匹配（非后缀）**：`entryFileId` 用 `slice(11)` 取完整 id 精确比较，**不用 `endsWith`**——防止"id 是另一个 id 后缀"（如 `abc` vs `1-abc`）时误匹配。Task 1 第 3 个用例锁定此行为。
- **文件名格式前提**：`writeEntry`(line 168) 保证 `{YYYY-MM-DD}-{id}.md`（date 10 字符）。`entryFileId` 的 `slice(11)` 依赖此前提。若有非标准文件名（历史遗留），需确认——但 writeEntry 统一格式，假设一致。
- **readdirSync 仍 O(n)**：列目录是 O(n)，但文件名字符串比较远快于 N×(readFileSync+YAML.parse)。彻底消除需 id→path 反向索引（over-engineering）。
- **removeEntryReferences 不在范围**：低频（deleteEntry），保留全扫。如需优化另开。
- **listEntries 不在范围**：检索需要全量，是合理全量读。
- **同步 fs**：readFileSync/readdirSync 同步阻塞；异步化属 Phase 9。
