# model-meta「更新模型数据」按钮（子项目 B）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在「设置 → 数据管理」加「更新模型数据」按钮，点击后 sidecar 从 models.dev 同步 catalog、生成 generated、原子写入 config dir、热更新到 web（无需重启）。

**Architecture:** sidecar SYNC handler（`fetchWithProxy` + `buildGeneratedFromCatalog` + 原子写 + 返回未 merge generated）；web 第⑤卡按钮调 `syncModelMeta()` → `useModelMetaReload(generated)`（A 预留）→ 6 处消费者热更新。B 只消费 A 接口，不改 A 行为。详见 spec `docs/superpowers/specs/2026-07-08-model-meta-sync-button-design.md`。

**Tech Stack:** TypeScript, React, Electron, Bun（sidecar + 测试）, bun:test, sonner（toast）

## Global Constraints

- B **只消费 A 接口**，不改 A 的 `setModelMeta` / `useModelMetaVersion` / `useModelMetaReload` / `applyModelMetaUpdate` / GET handler 任何行为。
- sidecar SYNC 返回**未 merge 的原始 generated**（`ModelMeta[]`）；merge 只在 web `setModelMeta` 内（A 决策 6）。
- fetch 用 `fetchWithProxy`（`apps/sidecar/src/services/infra/proxy-fetch.ts:87`，尊重代理 + curl 路径 `--max-time 20s`）。
- 原子写：tmp + rename（先写 `.tmp` 再覆盖）。
- UI 沿用 `handleClear` 模式（`DataManagementSettings.tsx:79-91`）：useState 布尔 + Loader2 替换图标 + sonner toast + finally。
- 测试用 bun:test；sidecar handler 测试用 `LUME_CONFIG_DIR` env 注入临时目录 + `mock.module` mock `fetchWithProxy`（离线、确定性）。
- 代码注释中文。
- **提交约定**：项目 SDD 惯例 NO auto-commit；每 task 末尾 commit step 在执行时需用户确认。spec + plan 可成对提交。

## File Structure

| 文件 | 职责 | 动作 |
|---|---|---|
| `packages/shared/src/types/model-meta.ts` | `MODEL_META_IPC_CHANNELS` 加 `SYNC` | 修改 |
| `packages/shared/src/types/model-meta.test.ts` | SYNC 常量测试 | 修改 |
| `apps/sidecar/src/rpc/model-meta-handlers.ts` | 加 SYNC handler + `atomicWriteGenerated` + import fetchWithProxy/buildGeneratedFromCatalog | 修改 |
| `apps/sidecar/src/rpc/model-meta-handlers.test.ts` | SYNC handler 测试（mock fetchWithProxy） | 修改 |
| `apps/web/src/lib/desktop-api/model.ts` | 加 `syncModelMeta()` | 修改 |
| `apps/web/src/components/settings/DataManagementSettings.tsx` | 第⑤卡 + `handleSyncModelMeta` + `syncing` state + import | 修改 |

---

### Task 1: shared — MODEL_META_IPC_CHANNELS 加 SYNC

**Files:**
- Modify: `packages/shared/src/types/model-meta.ts:7-10`
- Test: `packages/shared/src/types/model-meta.test.ts`

**Interfaces:**
- Produces: `MODEL_META_IPC_CHANNELS.SYNC` = `"model-meta:sync"`（Task 2/3 消费）

- [ ] **Step 1: 写失败测试**

在 `packages/shared/src/types/model-meta.test.ts` 现有 `describe('MODEL_META_IPC_CHANNELS', ...)` 块内追加用例：

```ts
  test('SYNC channel 常量为 model-meta:sync', () => {
    expect(MODEL_META_IPC_CHANNELS.SYNC).toBe('model-meta:sync')
  })
```

- [ ] **Step 2: 运行测试验证失败**

Run: `bun test packages/shared/src/types/model-meta.test.ts`
Expected: FAIL — `MODEL_META_IPC_CHANNELS` 上无 `SYNC` 属性。

- [ ] **Step 3: 加 SYNC 枚举**

修改 `packages/shared/src/types/model-meta.ts`，在 `GET` 后加 `SYNC`：

```ts
export const MODEL_META_IPC_CHANNELS = {
  /** 读取 config dir 的 generated.json（未 merge）；ENOENT 返回 null，调用方保持 seed */
  GET: "model-meta:get",
  /** 从 models.dev 同步 catalog → 生成 generated → 原子写 config dir → 返回未 merge 的 generated */
  SYNC: "model-meta:sync",
} as const
```

- [ ] **Step 4: 运行测试验证通过**

Run: `bun test packages/shared/src/types/model-meta.test.ts`
Expected: PASS（含原 GET 用例 + 新 SYNC 用例，3 用例）。

- [ ] **Step 5: typecheck**

Run: `cd packages/shared && bunx tsc -p tsconfig.json --noEmit`
Expected: 无错误。

- [ ] **Step 6: Commit**（需用户确认）

```bash
git add packages/shared/src/types/model-meta.ts packages/shared/src/types/model-meta.test.ts
git commit -m "✨ feat(shared): MODEL_META_IPC_CHANNELS 加 SYNC 通道"
```

---

### Task 2: sidecar — SYNC handler（fetchWithProxy + buildGenerated + 原子写）

**Files:**
- Modify: `apps/sidecar/src/rpc/model-meta-handlers.ts`
- Test: `apps/sidecar/src/rpc/model-meta-handlers.test.ts`

**Interfaces:**
- Consumes: `MODEL_META_IPC_CHANNELS.SYNC`（Task 1）；`fetchWithProxy`（`../services/infra/proxy-fetch`）；`buildGeneratedFromCatalog` + `Catalog` + `ModelMeta`（`@lume/shared`）；`getConfigDir`
- Produces: `createModelMetaHandlers()` 返回对象新增 `[SYNC]` handler，返回 `ModelMeta[]`（未 merge）

- [ ] **Step 1: 写失败测试**

在 `apps/sidecar/src/rpc/model-meta-handlers.test.ts` 现有 describe 块外（或新增 describe）追加 SYNC 测试。用 `mock.module` mock `fetchWithProxy`，`LUME_CONFIG_DIR` env 注入临时目录（沿用 A Task 4 的 env 模式）：

```ts
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MODEL_META_IPC_CHANNELS } from '@lume/shared'

describe('createModelMetaHandlers SYNC', () => {
  let tmpDir: string
  let prevEnv: string | undefined

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lume-mm-sync-'))
    prevEnv = process.env.LUME_CONFIG_DIR
    process.env.LUME_CONFIG_DIR = tmpDir
  })
  afterEach(async () => {
    mock.restore()
    if (prevEnv === undefined) delete process.env.LUME_CONFIG_DIR
    else process.env.LUME_CONFIG_DIR = prevEnv
    await rm(tmpDir, { recursive: true, force: true })
  })
  afterAll(() => { mock.restore() })

  test('成功：fetch + build + 原子写 + 返回未 merge generated', async () => {
    const miniCatalog = {
      providers: {
        openai: { models: { 'gpt-sync-test': { name: 'GPT Sync Test', tool_call: true, limit: { context: 8000 } } } },
      },
    }
    mock.module('../services/infra/proxy-fetch', () => ({
      fetchWithProxy: async () => new Response(JSON.stringify(miniCatalog), { status: 200 }),
    }))
    const { createModelMetaHandlers } = await import('./model-meta-handlers')
    const handlers = createModelMetaHandlers()
    const result = (await handlers[MODEL_META_IPC_CHANNELS.SYNC]!(null)) as Array<{ id: string }>
    expect(result.map((m) => m.id)).toContain('gpt-sync-test')
    // 验证 config dir 文件已原子写入，内容 = buildGeneratedFromCatalog 输出
    const written = JSON.parse(await readFile(join(tmpDir, 'model-meta.generated.json'), 'utf8')) as Array<{ id: string }>
    expect(written.map((m) => m.id)).toContain('gpt-sync-test')
    // .tmp 不残留
    await expect(readFile(join(tmpDir, 'model-meta.generated.json.tmp'), 'utf8')).rejects.toThrow()
  })

  test('fetch !ok → throw', async () => {
    mock.module('../services/infra/proxy-fetch', () => ({
      fetchWithProxy: async () => new Response('service unavailable', { status: 503 }),
    }))
    const { createModelMetaHandlers } = await import('./model-meta-handlers')
    const handlers = createModelMetaHandlers()
    await expect(handlers[MODEL_META_IPC_CHANNELS.SYNC]!(null)).rejects.toThrow(/503/)
  })
})
```

- [ ] **Step 2: 运行测试验证失败**

Run: `bun test apps/sidecar/src/rpc/model-meta-handlers.test.ts`
Expected: FAIL — `MODEL_META_IPC_CHANNELS.SYNC` handler 不存在（`handlers[SYNC]` 为 `undefined`，`!` 断言报错或调用报 not a function）。

- [ ] **Step 3: 实现 SYNC handler**

修改 `apps/sidecar/src/rpc/model-meta-handlers.ts`。改 import + 加 `CATALOG_URL` + `atomicWriteGenerated` + SYNC handler：

```ts
import { MODEL_META_IPC_CHANNELS, buildGeneratedFromCatalog, type Catalog, type ModelMeta } from "@lume/shared"
import { getConfigDir } from "../services/infra/config-paths"
import { fetchWithProxy } from "../services/infra/proxy-fetch"
import { readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { RpcHandler } from "./types"

/** 运行时 generated.json 文件名（与源码目录同名，语义一致） */
const GENERATED_FILE = "model-meta.generated.json"

/** models.dev catalog 端点 */
const CATALOG_URL = "https://models.dev/catalog.json"

/** 原子写：先写 .tmp 再 rename 覆盖，避免中途失败污染现有文件 */
async function atomicWriteGenerated(targetPath: string, generated: ModelMeta[]): Promise<void> {
  const tmpPath = `${targetPath}.tmp`
  await writeFile(tmpPath, `${JSON.stringify(generated, null, 2)}\n`, "utf8")
  await rename(tmpPath, targetPath)
}

/**
 * 无状态 model-meta 数据提供者：只读写 config dir 文件，不持有 registry。
 * GET 返回未 merge 的原始 generated（web 侧 setModelMeta 内统一 merge）；
 * 文件不存在返回 null（首次启动，web 保持 seed）；损坏/权限抛错。
 * SYNC 从 models.dev 拉取 catalog → 生成 generated → 原子写 → 返回未 merge generated。
 */
export function createModelMetaHandlers(): Record<string, RpcHandler> {
  return {
    [MODEL_META_IPC_CHANNELS.GET]: async () => {
      const filePath = join(getConfigDir(), GENERATED_FILE)
      try {
        return JSON.parse(await readFile(filePath, "utf8"))
      } catch (e) {
        if (e instanceof Error && "code" in e && (e as NodeJS.ErrnoException).code === "ENOENT") return null
        throw e
      }
    },
    [MODEL_META_IPC_CHANNELS.SYNC]: async () => {
      const res = await fetchWithProxy(CATALOG_URL)
      if (!res.ok) throw new Error(`fetch models.dev: HTTP ${res.status}`)
      const catalog = (await res.json()) as Catalog
      const generated = buildGeneratedFromCatalog(catalog)
      await atomicWriteGenerated(join(getConfigDir(), GENERATED_FILE), generated)
      return generated
    },
  }
}
```

> 注意：原文件 import 仅为 `MODEL_META_IPC_CHANNELS`，本步扩展为含 `buildGeneratedFromCatalog` / `Catalog` / `ModelMeta`，并把 `readFile` 扩展为 `readFile, rename, writeFile`。

- [ ] **Step 4: 运行测试验证通过**

Run: `bun test apps/sidecar/src/rpc/model-meta-handlers.test.ts`
Expected: PASS（含原 GET 3 用例 + 新 SYNC 2 用例，共 5 用例）。

- [ ] **Step 5: sidecar typecheck**

Run: `cd apps/sidecar && bunx tsc -p tsconfig.json --noEmit`
Expected: model-meta 相关文件 0 新增错误（sidecar 有 21 个 pre-existing 错误，非本任务）。

- [ ] **Step 6: Commit**（需用户确认）

```bash
git add apps/sidecar/src/rpc/model-meta-handlers.ts apps/sidecar/src/rpc/model-meta-handlers.test.ts
git commit -m "✨ feat(sidecar): model-meta SYNC handler（fetchWithProxy+buildGenerated+原子写）"
```

---

### Task 3: web — syncModelMeta desktop-api 桥

**Files:**
- Modify: `apps/web/src/lib/desktop-api/model.ts`

**Interfaces:**
- Consumes: `sidecarCall`（`./system`）；`MODEL_META_IPC_CHANNELS.SYNC`（Task 1）；`ModelMeta`（`@lume/shared`）
- Produces: `syncModelMeta(): Promise<ModelMeta[]>`

> 说明：`syncModelMeta` 是 `sidecarCall` 薄包装，不单独写单测（覆盖由 Task 4 UI 测试 + Task 5 集成验证承担，对齐 A Task 5）。`desktop-api/index.ts` 已 `export * from './model'`（A Task 5），`syncModelMeta` 自动导出。

- [ ] **Step 1: 加 syncModelMeta**

修改 `apps/web/src/lib/desktop-api/model.ts`，在 `getModelMeta` 后追加：

```ts
/**
 * 从 models.dev 同步 catalog → sidecar 生成 generated + 原子写 config dir → 返回未 merge 的 generated。
 * 调用方（DataManagementSettings 按钮）拿到后经 useModelMetaReload 触发 setModelMeta + version bump。
 */
export const syncModelMeta = () =>
  sidecarCall<ModelMeta[]>(MODEL_META_IPC_CHANNELS.SYNC, {})
```

- [ ] **Step 2: web typecheck**

Run: `cd apps/web && bunx tsc -p tsconfig.json --noEmit`
Expected: `model.ts` 无新增错误（web 有 pre-existing ModelPicker effectiveModelRef 错误，非本任务）。

- [ ] **Step 3: Commit**（需用户确认）

```bash
git add apps/web/src/lib/desktop-api/model.ts
git commit -m "✨ feat(web): syncModelMeta sidecar 调用桥"
```

---

### Task 4: web — DataManagementSettings 第⑤卡「更新模型数据」

**Files:**
- Modify: `apps/web/src/components/settings/DataManagementSettings.tsx`

**Interfaces:**
- Consumes: `syncModelMeta`（Task 3，`@/lib/desktop-api`）；`useModelMetaReload`（A 产物，`@/lib/model-meta-context`）；`toast`（sonner，已 import）；`RefreshCw`/`Loader2`（lucide，已 import L6-7）
- Produces: 第⑤卡 UI + `handleSyncModelMeta`

> 说明：UI 改动，靠类型 + Task 5 verify（fakeDom 组件测试 YAGNI，对齐 A Task 7/8）。

- [ ] **Step 1: 加 import**

在 `apps/web/src/components/settings/DataManagementSettings.tsx` 的 desktop-api import 块（L26-35）加 `syncModelMeta`（字母序置于 `saveFilePathDialog` 后）：

```ts
import {
  applyMigration,
  clearCache,
  emptyTrash,
  exportZip,
  getStorageStats,
  migrateToDir,
  openFolderDialog,
  revealPathInSystem,
  saveFilePathDialog,
  syncModelMeta,
} from '@/lib/desktop-api'
```

在 desktop-api import 块后（L42 `data-management-state` import 后）加新行：

```ts
import { useModelMetaReload } from '@/lib/model-meta-context'
```

- [ ] **Step 2: 加 state + reload hook**

在组件 state 区（`exporting` 后，L52 附近）加：

```ts
  const [syncing, setSyncing] = React.useState(false)
```

在 state 区末尾（`migrateError` 后，L58 后）加 reload hook：

```ts
  const reloadModelMeta = useModelMetaReload()
```

- [ ] **Step 3: 加 handleSyncModelMeta**

在 `handleClear`（L91 `}`）后、`handleEmptyTrash` 前加（沿用 handleClear 模式）：

```ts
  const handleSyncModelMeta = async () => {
    setSyncing(true)
    try {
      const generated = await syncModelMeta()
      await reloadModelMeta(generated)
      toast.success(`已更新 ${generated.length} 个模型`)
    } catch (error) {
      console.error('[DataManagement] syncModelMeta FAILED:', error)
      toast.error(`更新失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setSyncing(false)
    }
  }
```

- [ ] **Step 4: 加第⑤卡 UI**

在 ④ 数据位置 `</section>`（L282）后、`{/* 清空回收站（危险，独立折叠） */}`（L284）前插入第⑤卡（保持 danger 卡始终在末尾）：

```tsx
      {/* ⑤ 更新模型数据 */}
      <section className="lume-panel-padded">
        <h2 className="mb-3 text-[16px] font-semibold leading-6 text-[var(--text-1)]">更新模型数据</h2>
        <p className="mb-3 text-[12px] leading-5 text-[var(--text-3)]">
          从 models.dev 同步最新模型元数据（定价、上下文窗口、能力标记）。更新后立即生效，无需重启。
        </p>
        <div className="flex justify-end">
          <Button onClick={handleSyncModelMeta} disabled={syncing} className="h-9 gap-1.5 rounded-[8px] px-4 text-[13px]">
            {syncing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            {syncing ? '更新中…' : '立即更新'}
          </Button>
        </div>
      </section>
```

- [ ] **Step 5: web typecheck**

Run: `cd apps/web && bunx tsc -p tsconfig.json --noEmit`
Expected: DataManagementSettings.tsx 无新增错误。

- [ ] **Step 6: 既有测试回归**

Run: `bun test apps/web/src/components/agent/AgentView.test.tsx`
Expected: PASS（既有测试不因加按钮破坏）。

- [ ] **Step 7: Commit**（需用户确认）

```bash
git add apps/web/src/components/settings/DataManagementSettings.tsx
git commit -m "✨ feat(web): 数据管理第⑤卡「更新模型数据」按钮"
```

---

### Task 5: 集成验证

**Files:** 无改动（仅验证）

- [ ] **Step 1: 全端 typecheck**

Run: `cd packages/shared && bunx tsc -p tsconfig.json --noEmit && cd ../../apps/sidecar && bunx tsc -p tsconfig.json --noEmit && cd ../web && bunx tsc -p tsconfig.json --noEmit`
Expected: model-meta 相关文件 0 新增错误（pre-existing：sidecar 21 / web 1，均无关）。

- [ ] **Step 2: 全端测试**

Run: `bun test packages/shared/src/types/model-meta.test.ts apps/sidecar/src/rpc/model-meta-handlers.test.ts`
Expected: 全 PASS（types 3 用例 + handlers 5 用例）。

- [ ] **Step 3: app 启动验证（手动，Electron GUI）**

启动 app（`pnpm dev`）→ 设置 → 数据管理 → 第⑤卡「更新模型数据」：
1. 点「立即更新」→ 按钮变「更新中…」+ spinner
2. 成功 → toast「已更新 N 个模型」+ 模型选择界面（如 ModelPicker）的元数据刷新（验证 6 处消费者响应 version bump）
3. 断网或代理失败点 → toast「更新失败：...」+ seed 数据保持不变（UI 不崩）
4. 验证 `%USERPROFILE%\.lume\model-meta.generated.json` 已写入（且无 `.tmp` 残留）

Expected: 上述 4 项均符合。

- [ ] **Step 4: 可选 — invoke verify skill**

Run: `/verify`
Expected: verify 通过。

---

## Self-Review

**1. Spec coverage**：

| Spec 章节 | 覆盖 Task |
|---|---|
| §1 背景（A 完成，B 是入口） | 无需实现（背景） |
| §2 目标 — SYNC channel + handler | Task 1 + Task 2 |
| §2 目标 — 第⑤卡按钮 + useModelMetaReload | Task 3 + Task 4 |
| §2 目标 — loading/toast 沿用模式 | Task 4（handleSyncModelMeta 沿用 handleClear） |
| §3 决策 1 fetch 归属 sidecar | Task 2 |
| §3 决策 2 fetchWithProxy | Task 2（import + 调用） |
| §3 决策 3 复用 buildGeneratedFromCatalog | Task 2 |
| §3 决策 4 原子写 tmp+rename | Task 2（atomicWriteGenerated） |
| §3 决策 5 返回未 merge | Task 2（return generated）+ Task 3 类型 `ModelMeta[]` |
| §3 决策 6 handleClear 模式 | Task 4 |
| §3 决策 7 pull 模式 | Task 4（syncModelMeta 响应 → reloadModelMeta，无二次 get） |
| §4 数据流 | Task 2 + Task 4 |
| §5 组件改动 | Task 1-4 逐项 |
| §6 SYNC handler 细节 | Task 2（逐字） |
| §7 UI 交互 | Task 4（逐字） |
| §8 测试 | Task 1（常量）+ Task 2（mock fetchWithProxy）+ Task 5（集成） |

**2. Placeholder scan**：无 TBD/TODO；每步含 exact code。

**3. Type consistency**：
- `MODEL_META_IPC_CHANNELS.SYNC` = `"model-meta:sync"` — Task 1 定义，Task 2 + Task 3 消费 ✓
- `syncModelMeta(): Promise<ModelMeta[]>` — Task 3 定义，Task 4 消费 ✓
- `useModelMetaReload(): (generated?) => Promise<void>` — A 定义，Task 4 消费（`reloadModelMeta(generated)`）✓
- SYNC handler 返回 `ModelMeta[]`（未 merge）— Task 2 实现 + Task 3 类型 + Task 4 消费一致 ✓
- `atomicWriteGenerated(targetPath, generated: ModelMeta[])` — Task 2 定义 + 调用一致 ✓

无类型不一致。Plan 与 spec 自洽。
