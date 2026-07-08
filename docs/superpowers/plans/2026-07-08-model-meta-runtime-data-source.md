# model-meta 运行时数据源改造（子项目 A）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 model-meta 从 build-time bundled 改造为运行时数据源——web 启动期从 sidecar 拉取 config dir 的 generated.json 覆盖 seed，`findModelMeta` 同步签名零变更，reload 后 6 处消费者自动重算。

**Architecture:** sidecar 是无状态数据提供者（GET 读 config dir generated.json，ENOENT→null）；web 持 mutable registry（seed 初始化 + sidecar 异步覆盖 + version Context 感知 reload）。merge 单一在 web 侧 `setModelMeta` 内。详见 spec `docs/superpowers/specs/2026-07-08-model-meta-runtime-data-source-design.md`。

**Tech Stack:** TypeScript, React, Electron, Bun（sidecar 运行时 + 全端测试）, bun:test

## Global Constraints

- `findModelMeta` / `inferCapabilities` / format\* 同步签名与行为零变更。
- sidecar GET 返回**未 merge 的原始 generated**（`ModelMeta[] | null`）；`mergeModelMeta(generated, MODEL_OVERRIDES)` 只在 web `setModelMeta` 内做一次。
- 测试用 `bun:test`（shared/sidecar/web 约定），组件测试参考 `AgentView.test.tsx`。
- generated.json 运行时位置：`getConfigDir()`（`~/.lume`，可被 `LUME_CONFIG_DIR` env 覆盖）+ 文件名 `model-meta.generated.json`。
- `MODEL_OVERRIDES` 编译期 import 不变；merge 复用现有 `mergeModelMeta`，不新建合并逻辑。
- 代码注释语言与现有代码库一致（中文，见 `model-meta.ts` / `merge-models.ts`）。
- **提交约定**：项目不主动 git commit；每 task 末尾的 commit step 在执行时需用户确认。spec + plan 可在计划完成后成对提交。

## File Structure

| 文件 | 职责 | 动作 |
|---|---|---|
| `packages/shared/src/data/model-meta.ts` | mutable registry + seed 导出 + `setModelMeta` | 修改 |
| `packages/shared/src/data/catalog-mapping.ts` | `buildGeneratedFromCatalog` 纯函数 + Catalog 类型 + 白名单 | 新建 |
| `packages/shared/src/data/catalog-mapping.test.ts` | 纯函数测试（从 scripts 迁移） | 新建 |
| `packages/shared/scripts/sync-models.ts` | 改为 import catalog-mapping，保留 fetch+main+write | 修改 |
| `packages/shared/scripts/sync-models.test.ts` | 已迁至 catalog-mapping.test.ts | 删除 |
| `packages/shared/src/types/model-meta.ts` | `MODEL_META_IPC_CHANNELS` 枚举 | 新建 |
| `packages/shared/src/types/model-meta.test.ts` | 枚举常量测试 | 新建 |
| `packages/shared/src/index.ts` | re-export catalog-mapping | 修改 |
| `apps/sidecar/src/rpc/model-meta-handlers.ts` | `createModelMetaHandlers` GET handler | 新建 |
| `apps/sidecar/src/rpc/model-meta-handlers.test.ts` | handler 测试（env 注入） | 新建 |
| `apps/sidecar/src/rpc/create-rpc-handlers.ts` | 聚合 model-meta handlers | 修改 |
| `apps/web/src/lib/desktop-api/model.ts` | `getModelMeta()` sidecar 调用 | 新建 |
| `apps/web/src/lib/desktop-api/index.ts` | re-export model | 修改 |
| `apps/web/src/lib/model-meta-context.tsx` | `ModelMetaProvider` + `useModelMetaVersion` + `useModelMetaReload` + `applyModelMetaUpdate` | 新建 |
| `apps/web/src/lib/model-meta-context.test.ts` | `applyModelMetaUpdate` 纯函数测试 | 新建 |
| `apps/web/src/App.tsx` | 根挂 `ModelMetaProvider` | 修改 |
| 6 处消费者 | `useModelMetaVersion` 接入 | 修改 |

---

### Task 1: shared — mutable registry + setModelMeta

**Files:**
- Modify: `packages/shared/src/data/model-meta.ts:43-61`
- Test: `packages/shared/src/data/model-meta.test.ts`

**Interfaces:**
- Produces: `setModelMeta(generated: ModelMeta[]): void`（接收未 merge 的原始 generated，内部 `mergeModelMeta(generated, MODEL_OVERRIDES)`）；`MODEL_META_SEED: ModelMeta[]`（seed 原始数据，供 web 测试恢复）

- [ ] **Step 1: 写失败测试**

在 `packages/shared/src/data/model-meta.test.ts` 末尾追加：

```ts
import generatedJson from './model-meta.generated.json'

describe('setModelMeta', () => {
  afterEach(() => {
    setModelMeta(generatedJson as unknown as ModelMeta[])
  })

  test('替换 registry 后 findModelMeta 返回新数据', () => {
    const custom: ModelMeta[] = [
      {
        id: 'custom-test-model',
        displayName: 'Custom',
        contextWindow: 999,
        capabilities: { vision: false, toolUse: true, reasoning: false },
      },
    ]
    setModelMeta(custom)
    const meta = findModelMeta('custom-test-model')
    expect(meta).toBeDefined()
    expect(meta!.displayName).toBe('Custom')
    expect(meta!.contextWindow).toBe(999)
  })

  test('重建 lookupMap（alias 正确）', () => {
    const withAlias: ModelMeta[] = [
      {
        id: 'm1',
        aliases: ['alias-1'],
        displayName: 'M1',
        contextWindow: 100,
        capabilities: { vision: false, toolUse: false, reasoning: false },
      },
    ]
    setModelMeta(withAlias)
    expect(findModelMeta('alias-1')?.id).toBe('m1')
  })

  test('MODEL_META_SEED 等于 generated 原始数据', () => {
    expect(MODEL_META_SEED).toEqual(generatedJson)
  })
})
```

在文件顶部 import 行补充 `setModelMeta`、`MODEL_META_SEED`、`type ModelMeta`：

```ts
import { findModelMeta, formatContextWindow, formatPricing, setModelMeta, MODEL_META_SEED, type ModelMeta } from './model-meta'
```

- [ ] **Step 2: 运行测试验证失败**

Run: `bun test packages/shared/src/data/model-meta.test.ts`
Expected: FAIL — `setModelMeta` / `MODEL_META_SEED` 未导出（`Identifier is not exported`）。

- [ ] **Step 3: 实现 mutable registry**

修改 `packages/shared/src/data/model-meta.ts`。把 `MODEL_META_REGISTRY`、`lookupMap` 从 `const` 改 `let`，`buildLookupMap` 改为接收参数，新增 `setModelMeta` + `MODEL_META_SEED`：

```ts
/**
 * 最终注册表 = generated（models.dev 同步）⊕ override（人工稳定层）。
 * 公开 API 行为与原硬编码 registry 一致。运行时可经 setModelMeta 替换。
 */
let MODEL_META_REGISTRY: ModelMeta[] = mergeModelMeta(
  generatedJson as unknown as ModelMeta[],
  MODEL_OVERRIDES,
)

/** build-time bundled seed（运行时 fallback / 初始值），供测试恢复等场景使用 */
export const MODEL_META_SEED: ModelMeta[] = generatedJson as unknown as ModelMeta[]

function buildLookupMap(registry: ModelMeta[]): Map<string, ModelMeta> {
  const map = new Map<string, ModelMeta>()
  for (const meta of registry) {
    map.set(meta.id, meta)
    if (meta.aliases) {
      for (const alias of meta.aliases) {
        map.set(alias, meta)
      }
    }
  }
  return map
}

let lookupMap = buildLookupMap(MODEL_META_REGISTRY)

/**
 * 运行时替换 registry：接收未 merge 的原始 generated，内部应用 override 后重建 lookupMap。
 * 供 web 启动期加载 / reload 时调用。findModelMeta 同步签名不变。
 */
export function setModelMeta(generated: ModelMeta[]): void {
  MODEL_META_REGISTRY = mergeModelMeta(generated, MODEL_OVERRIDES)
  lookupMap = buildLookupMap(MODEL_META_REGISTRY)
}
```

`findModelMeta` 内部读 `MODEL_META_REGISTRY` / `lookupMap`（现为 `let`，引用自动跟进）——**不改 findModelMeta 函数体**。

- [ ] **Step 4: 运行测试验证通过**

Run: `bun test packages/shared/src/data/model-meta.test.ts`
Expected: PASS（含原有 findModelMeta/format\* 测试 + 新 setModelMeta 测试）。

- [ ] **Step 5: typecheck**

Run: `cd packages/shared && bun run typecheck`（若无 typecheck 脚本，`bunx tsc -p tsconfig.json --noEmit`）
Expected: 无错误。

- [ ] **Step 6: Commit**（需用户确认）

```bash
git add packages/shared/src/data/model-meta.ts packages/shared/src/data/model-meta.test.ts
git commit -m "♻️ refactor(shared): model-meta registry 改 mutable + setModelMeta + MODEL_META_SEED"
```

---

### Task 2: shared — 提取 buildGeneratedFromCatalog 到 catalog-mapping.ts

**Files:**
- Create: `packages/shared/src/data/catalog-mapping.ts`
- Create: `packages/shared/src/data/catalog-mapping.test.ts`
- Modify: `packages/shared/scripts/sync-models.ts`
- Delete: `packages/shared/scripts/sync-models.test.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Produces: `buildGeneratedFromCatalog(catalog: Catalog): ModelMeta[]`（纯函数）；`WHITELIST_PROVIDERS`；`Catalog` / `CatalogModel` / `CatalogProvider` 等类型
- Consumes: `ModelMeta` / `ModelCapabilities` / `ModelPricing` from `./model-meta`

- [ ] **Step 1: 迁移测试到 catalog-mapping.test.ts**

创建 `packages/shared/src/data/catalog-mapping.test.ts`，内容复制自 `packages/shared/scripts/sync-models.test.ts`，仅改 import 路径：

```ts
import { describe, expect, test } from 'bun:test'
import type { ModelMeta } from './model-meta'
import { buildGeneratedFromCatalog } from './catalog-mapping'
import type { Catalog } from './catalog-mapping'

const mkModel = (over: Record<string, unknown>) => over

const miniCatalog: Catalog = {
  providers: {
    openai: {
      models: {
        'gpt-5.2': mkModel({
          name: 'GPT-5.2', description: 'Reliable GPT generation',
          attachment: true, reasoning: true, tool_call: true,
          modalities: { input: ['text', 'image'], output: ['text'] },
          limit: { context: 400000, output: 128000 },
          cost: { input: 1.75, output: 14, cache_read: 0.175 },
        }),
        'gpt-5.2-no-cost': mkModel({ name: 'GPT-5.2 NoCost', tool_call: true, limit: { context: 128000 } }),
        'vision-only': mkModel({
          name: 'Vision Only', tool_call: true,
          modalities: { input: ['text', 'image'], output: ['text'] },
          limit: { context: 8000 },
        }),
      },
    },
    anthropic: {
      models: {
        'claude-sonnet-4-5': mkModel({
          name: 'Claude Sonnet 4.5', attachment: true, reasoning: true, tool_call: true,
          modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
          limit: { context: 200000, output: 64000 },
          cost: { input: 3, output: 15 },
        }),
      },
    },
    openrouter: { models: { 'some-aggregated-model': mkModel({ name: 'X', tool_call: true, limit: { context: 8000 } }) } },
    deepseek: { models: { 'bad-model': mkModel({ name: 'Bad', tool_call: true }) } },
  },
}

describe('buildGeneratedFromCatalog', () => {
  const result = buildGeneratedFromCatalog(miniCatalog)

  test('收录白名单 provider 的模型', () => {
    expect(result.map((m) => m.id)).toContain('gpt-5.2')
    expect(result.map((m) => m.id)).toContain('claude-sonnet-4-5')
  })
  test('不收录非白名单 provider', () => {
    expect(result.map((m) => m.id)).not.toContain('some-aggregated-model')
  })
  test('字段映射正确', () => {
    const gpt = result.find((m) => m.id === 'gpt-5.2') as ModelMeta
    expect(gpt.displayName).toBe('GPT-5.2')
    expect(gpt.contextWindow).toBe(400000)
    expect(gpt.capabilities).toEqual({ vision: true, toolUse: true, reasoning: true })
    expect(gpt.description).toBe('Reliable GPT generation')
  })
  test('vision 也可由 modalities.input 含 image 推出', () => {
    const visionOnly = result.find((m) => m.id === 'vision-only') as ModelMeta
    expect(visionOnly.capabilities.vision).toBe(true)
  })
  test('定价单位不变（USD/1M tokens，禁止换算）', () => {
    const gpt = result.find((m) => m.id === 'gpt-5.2') as ModelMeta
    expect(gpt.pricing).toEqual({ input: 1.75, output: 14 })
  })
  test('缺 cost 的模型 pricing 省略', () => {
    const nocost = result.find((m) => m.id === 'gpt-5.2-no-cost') as ModelMeta
    expect(nocost.pricing).toBeUndefined()
  })
  test('缺 limit.context 的模型被跳过', () => {
    expect(result.map((m) => m.id)).not.toContain('bad-model')
  })
  test('结果按 id 字典序排序', () => {
    const ids = result.map((m) => m.id)
    expect(ids).toEqual([...ids].sort())
  })
})
```

- [ ] **Step 2: 运行测试验证失败**

Run: `bun test packages/shared/src/data/catalog-mapping.test.ts`
Expected: FAIL — `./catalog-mapping` 不存在。

- [ ] **Step 3: 创建 catalog-mapping.ts**

创建 `packages/shared/src/data/catalog-mapping.ts`，从 `scripts/sync-models.ts` 迁移 `WHITELIST_PROVIDERS`、Catalog 类型、`mapModel`、`buildGeneratedFromCatalog`：

```ts
import type { ModelCapabilities, ModelMeta, ModelPricing } from './model-meta'

/** 白名单 provider，按 canonical 优先级排序（先到先得去重，聚合器不入表）。 */
export const WHITELIST_PROVIDERS = [
  'anthropic', 'openai', 'google', 'zhipuai', 'deepseek', 'alibaba',
  'moonshotai', 'stepfun', 'minimax', 'xai', 'mistral', 'cohere', 'meta',
] as const

export interface CatalogCost {
  input?: number
  output?: number
  cache_read?: number
  cache_write?: number
}
export interface CatalogLimit { context?: number; input?: number; output?: number }
export interface CatalogModalities { input?: string[]; output?: string[] }
export interface CatalogModel {
  id?: string
  name?: string
  description?: string
  attachment?: boolean
  reasoning?: boolean
  tool_call?: boolean
  modalities?: CatalogModalities
  limit?: CatalogLimit
  cost?: CatalogCost
}
export interface CatalogProvider { id?: string; name?: string; models?: Record<string, CatalogModel> }
export interface Catalog { models?: unknown; providers?: Record<string, CatalogProvider> }

/** 单条 catalog model → ModelMeta；缺 limit.context 或 name 返回 null。 */
function mapModel(modelId: string, m: CatalogModel): ModelMeta | null {
  const contextWindow = m.limit?.context
  if (!contextWindow || !m.name) {
    console.warn(`[catalog-mapping] skip "${modelId}": missing limit.context or name`)
    return null
  }
  const capabilities: ModelCapabilities = {
    vision: Boolean(m.attachment) || (m.modalities?.input?.includes('image') ?? false),
    toolUse: m.tool_call ?? false,
    reasoning: m.reasoning ?? false,
  }
  const meta: ModelMeta = { id: modelId, displayName: m.name, contextWindow, capabilities }
  if (m.description) meta.description = m.description
  if (m.cost?.input !== undefined && m.cost?.output !== undefined) {
    const pricing: ModelPricing = { input: m.cost.input, output: m.cost.output }
    meta.pricing = pricing
  }
  return meta
}

/** 纯函数：从 catalog 映射出 generated ModelMeta[]（白名单过滤 + canonical 去重 + 字典序）。 */
export function buildGeneratedFromCatalog(catalog: Catalog): ModelMeta[] {
  const seen = new Set<string>()
  const out: ModelMeta[] = []
  for (const providerId of WHITELIST_PROVIDERS) {
    const provider = catalog.providers?.[providerId]
    if (!provider?.models) {
      console.warn(`[catalog-mapping] provider "${providerId}" not in catalog, skipping`)
      continue
    }
    for (const [modelId, m] of Object.entries(provider.models)) {
      if (seen.has(modelId)) continue
      const meta = mapModel(modelId, m)
      if (meta) {
        seen.add(modelId)
        out.push(meta)
      }
    }
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return out
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `bun test packages/shared/src/data/catalog-mapping.test.ts`
Expected: PASS。

- [ ] **Step 5: 改 sync-models.ts 复用 catalog-mapping**

修改 `packages/shared/scripts/sync-models.ts`，删除已迁走的 `WHITELIST_PROVIDERS` / Catalog 类型 / `mapModel` / `buildGeneratedFromCatalog`，改为 import：

```ts
import { writeFileSync } from 'node:fs'
import { buildGeneratedFromCatalog, type Catalog } from '../src/data/catalog-mapping'

const CATALOG_URL = 'https://models.dev/catalog.json'
const OUTPUT_PATH = new URL('../src/data/model-meta.generated.json', import.meta.url)

async function fetchCatalog(): Promise<Catalog> {
  const res = await fetch(CATALOG_URL)
  if (!res.ok) throw new Error(`fetch ${CATALOG_URL}: HTTP ${res.status}`)
  return (await res.json()) as Catalog
}

async function main(): Promise<void> {
  const catalog = await fetchCatalog()
  const generated = buildGeneratedFromCatalog(catalog)
  // 不直接写 OUTPUT_PATH：先序列化成功后再落盘，避免中途失败污染现有文件
  const json = `${JSON.stringify(generated, null, 2)}\n`
  writeFileSync(OUTPUT_PATH, json, 'utf8')
  console.log(`[sync-models] wrote ${generated.length} models → ${OUTPUT_PATH.pathname}`)
}

if (import.meta.path === Bun.main) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
```

- [ ] **Step 6: 删除已迁移的 sync-models.test.ts**

删除 `packages/shared/scripts/sync-models.test.ts`（测试已迁至 `src/data/catalog-mapping.test.ts`）。

- [ ] **Step 7: shared/index.ts re-export catalog-mapping**

在 `packages/shared/src/index.ts` 的 `export * from "./data/model-meta";`（L10）后加一行：

```ts
export * from "./data/catalog-mapping";
```

- [ ] **Step 8: typecheck + 验证 sync 脚本可解析**

Run: `cd packages/shared && bunx tsc -p tsconfig.json --noEmit`
Expected: 无错误（sync-models.ts 的 import 解析正常）。

- [ ] **Step 9: Commit**（需用户确认）

```bash
git add packages/shared/src/data/catalog-mapping.ts packages/shared/src/data/catalog-mapping.test.ts packages/shared/scripts/sync-models.ts packages/shared/src/index.ts
git rm packages/shared/scripts/sync-models.test.ts
git commit -m "♻️ refactor(shared): 提取 buildGeneratedFromCatalog 到 catalog-mapping，scripts 与运行时共用"
```

---

### Task 3: shared — MODEL_META_IPC_CHANNELS 枚举

**Files:**
- Create: `packages/shared/src/types/model-meta.ts`
- Test: `packages/shared/src/types/model-meta.test.ts`

**Interfaces:**
- Produces: `MODEL_META_IPC_CHANNELS.GET` = `'model-meta:get'`（经 `index.ts:5 export * from "./types"` 自动从 `@lume/shared` 导出）

- [ ] **Step 1: 写失败测试**

创建 `packages/shared/src/types/model-meta.test.ts`：

```ts
import { describe, expect, test } from 'bun:test'
import { MODEL_META_IPC_CHANNELS } from '@lume/shared'

describe('MODEL_META_IPC_CHANNELS', () => {
  test('GET channel 常量为 model-meta:get', () => {
    expect(MODEL_META_IPC_CHANNELS.GET).toBe('model-meta:get')
  })

  test('从 @lume/shared 根导出可访问', () => {
    expect(typeof MODEL_META_IPC_CHANNELS.GET).toBe('string')
  })
})
```

- [ ] **Step 2: 运行测试验证失败**

Run: `bun test packages/shared/src/types/model-meta.test.ts`
Expected: FAIL — `MODEL_META_IPC_CHANNELS` 未从 `@lume/shared` 导出。

- [ ] **Step 3: 创建枚举**

创建 `packages/shared/src/types/model-meta.ts`：

```ts
// packages/shared/src/types/model-meta.ts

/**
 * model-meta 运行时数据源 IPC channel（sidecar RPC）。
 * 数据层 ModelMeta 接口在 data/model-meta.ts，本文件仅放 IPC 协议。
 */
export const MODEL_META_IPC_CHANNELS = {
  /** 读取 config dir 的 generated.json（未 merge）；ENOENT 返回 null，调用方保持 seed */
  GET: "model-meta:get",
} as const
```

- [ ] **Step 4: 运行测试验证通过**

Run: `bun test packages/shared/src/types/model-meta.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**（需用户确认）

```bash
git add packages/shared/src/types/model-meta.ts packages/shared/src/types/model-meta.test.ts
git commit -m "✨ feat(shared): 新增 MODEL_META_IPC_CHANNELS 枚举"
```

---

### Task 4: sidecar — GET handler（无状态数据提供者）

**Files:**
- Create: `apps/sidecar/src/rpc/model-meta-handlers.ts`
- Test: `apps/sidecar/src/rpc/model-meta-handlers.test.ts`
- Modify: `apps/sidecar/src/rpc/create-rpc-handlers.ts:1,42-60`

**Interfaces:**
- Consumes: `MODEL_META_IPC_CHANNELS.GET`（Task 3）；`getConfigDir()`（`apps/sidecar/src/services/infra/config-paths.ts:36`，读 `LUME_CONFIG_DIR` env）
- Produces: `createModelMetaHandlers(): Record<string, RpcHandler>`，GET 返回 `ModelMeta[] | null`（未 merge）

- [ ] **Step 1: 写失败测试**

创建 `apps/sidecar/src/rpc/model-meta-handlers.test.ts`。用 `LUME_CONFIG_DIR` env 注入临时目录（`getConfigDir` 读此 env）：

```ts
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MODEL_META_IPC_CHANNELS } from '@lume/shared'
import { createModelMetaHandlers } from './model-meta-handlers'

describe('createModelMetaHandlers GET', () => {
  let tmpDir: string
  let prevEnv: string | undefined

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lume-mm-'))
    prevEnv = process.env.LUME_CONFIG_DIR
    process.env.LUME_CONFIG_DIR = tmpDir
  })
  afterEach(async () => {
    if (prevEnv === undefined) delete process.env.LUME_CONFIG_DIR
    else process.env.LUME_CONFIG_DIR = prevEnv
    await rm(tmpDir, { recursive: true, force: true })
  })
  afterAll(() => { /* bun:test 无 mock.restore 需要 */ })

  test('有合法文件 → 返回 parsed ModelMeta[]', async () => {
    const data = [{ id: 'x', displayName: 'X', contextWindow: 100, capabilities: { vision: false, toolUse: false, reasoning: false } }]
    await writeFile(join(tmpDir, 'model-meta.generated.json'), JSON.stringify(data))
    const handlers = createModelMetaHandlers()
    const result = await handlers[MODEL_META_IPC_CHANNELS.GET]!(null)
    expect(result).toEqual(data)
  })

  test('文件不存在 → 返回 null（web 保持 seed）', async () => {
    const handlers = createModelMetaHandlers()
    const result = await handlers[MODEL_META_IPC_CHANNELS.GET]!(null)
    expect(result).toBeNull()
  })

  test('JSON 损坏 → throw', async () => {
    await writeFile(join(tmpDir, 'model-meta.generated.json'), '{not valid json')
    const handlers = createModelMetaHandlers()
    await expect(handlers[MODEL_META_IPC_CHANNELS.GET]!(null)).rejects.toThrow()
  })
})
```

- [ ] **Step 2: 运行测试验证失败**

Run: `bun test apps/sidecar/src/rpc/model-meta-handlers.test.ts`
Expected: FAIL — `./model-meta-handlers` 不存在。

- [ ] **Step 3: 实现 handler**

创建 `apps/sidecar/src/rpc/model-meta-handlers.ts`：

```ts
import { MODEL_META_IPC_CHANNELS } from "@lume/shared"
import { getConfigDir } from "../services/infra/config-paths"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { RpcHandler } from "./types"

/** 运行时 generated.json 文件名（与源码目录同名，语义一致） */
const GENERATED_FILE = "model-meta.generated.json"

/**
 * 无状态 model-meta 数据提供者：只读写 config dir 文件，不持有 registry。
 * GET 返回未 merge 的原始 generated（web 侧 setModelMeta 内统一 merge）；
 * 文件不存在返回 null（首次启动，web 保持 seed）；损坏/权限抛错。
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
  }
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `bun test apps/sidecar/src/rpc/model-meta-handlers.test.ts`
Expected: PASS（3 个用例）。

- [ ] **Step 5: 聚合到 create-rpc-handlers.ts**

修改 `apps/sidecar/src/rpc/create-rpc-handlers.ts`：

import 行（L7 附近，按字母序）加：

```ts
import { createModelMetaHandlers } from "./model-meta-handlers";
```

`Object.assign(handlers, ...)`（L42-60）的聚合链中，`createChannelHandlers(),` 后插入 `createModelMetaHandlers(),`：

```ts
  Object.assign(
    handlers,
    createSystemHandlers({
      getMethodNames: () => Object.keys(handlers).sort()
    }),
    createChannelHandlers(),
    createModelMetaHandlers(),
    createImHandlers(),
    createMemoryHandlers(),
    createReadingHandlers({
      writeNotification: context.writeNotification
    }),
    createAutomationHandlers(),
    createRoutineHandlers(),
    createAgentHandlers({
      writeNotification: context.writeNotification,
      planModePhaseTracker,
      notifyPlanModePhaseChange
    })
  );
```

- [ ] **Step 6: sidecar typecheck**

Run: `cd apps/sidecar && bunx tsc -p tsconfig.json --noEmit`
Expected: 无错误。

- [ ] **Step 7: Commit**（需用户确认）

```bash
git add apps/sidecar/src/rpc/model-meta-handlers.ts apps/sidecar/src/rpc/model-meta-handlers.test.ts apps/sidecar/src/rpc/create-rpc-handlers.ts
git commit -m "✨ feat(sidecar): model-meta GET handler（无状态读 config dir，ENOENT→null）"
```

---

### Task 5: web — getModelMeta desktop-api 调用

**Files:**
- Create: `apps/web/src/lib/desktop-api/model.ts`
- Modify: `apps/web/src/lib/desktop-api/index.ts`

**Interfaces:**
- Consumes: `sidecarCall`（`apps/web/src/lib/desktop-api/system.ts:20`）；`MODEL_META_IPC_CHANNELS.GET`；`ModelMeta`（`@lume/shared`）
- Produces: `getModelMeta(): Promise<ModelMeta[] | null>`

> 说明：`getModelMeta` 是 `sidecarCall` 薄包装，不单独写单元测试（薄包装层测试价值低，且会 mock `invoke`）。覆盖由 Task 6 Context 测试 + Task 9 集成验证承担。

- [ ] **Step 1: 创建 model.ts**

创建 `apps/web/src/lib/desktop-api/model.ts`（对齐 `channel.ts` / `mcp.ts` 域文件惯例）：

```ts
import { sidecarCall } from './system'
import { MODEL_META_IPC_CHANNELS, type ModelMeta } from '@lume/shared'

/**
 * 拉取 config dir 的 generated.json（未 merge 的原始 generated）。
 * 返回 null 表示 config dir 无文件（首次启动），调用方应保持 seed。
 */
export const getModelMeta = () =>
  sidecarCall<ModelMeta[] | null>(MODEL_META_IPC_CHANNELS.GET, {})
```

- [ ] **Step 2: index.ts re-export**

修改 `apps/web/src/lib/desktop-api/index.ts`，加一行（与其它域 export 并列）：

```ts
export * from './model'
```

- [ ] **Step 3: web typecheck**

Run: `cd apps/web && bunx tsc -p tsconfig.json --noEmit`（或项目 web typecheck 脚本）
Expected: 无错误。

- [ ] **Step 4: Commit**（需用户确认）

```bash
git add apps/web/src/lib/desktop-api/model.ts apps/web/src/lib/desktop-api/index.ts
git commit -m "✨ feat(web): getModelMeta sidecar 调用桥"
```

---

### Task 6: web — ModelMetaContext（Provider + version + reload）

**Files:**
- Create: `apps/web/src/lib/model-meta-context.tsx`
- Test: `apps/web/src/lib/model-meta-context.test.ts`

**Interfaces:**
- Consumes: `getModelMeta`（Task 5）；`setModelMeta`、`ModelMeta`（`@lume/shared`，Task 1）
- Produces: `ModelMetaProvider`（组件）；`useModelMetaVersion(): number`（6 处消费者用）；`useModelMetaReload(): (generated?) => Promise<void>`（子项目 B 按钮用）；`applyModelMetaUpdate(generated): boolean`（纯函数，可测）

- [ ] **Step 1: 写失败测试**

创建 `apps/web/src/lib/model-meta-context.test.ts`（纯函数测试，无需 DOM）：

```ts
import { afterEach, describe, expect, test } from 'bun:test'
import { findModelMeta, MODEL_META_SEED, setModelMeta, type ModelMeta } from '@lume/shared'
import { applyModelMetaUpdate } from './model-meta-context'

describe('applyModelMetaUpdate', () => {
  afterEach(() => setModelMeta(MODEL_META_SEED))

  test('null → 返回 false（保持 seed）', () => {
    expect(applyModelMetaUpdate(null)).toBe(false)
  })

  test('空数组 → 返回 true（setModelMeta 接受空，清空 registry）', () => {
    expect(applyModelMetaUpdate([])).toBe(true)
    expect(findModelMeta('gpt-4o')).toBeUndefined()
  })

  test('非空 generated → setModelMeta + 返回 true', () => {
    const custom: ModelMeta[] = [
      {
        id: 'ctx-test-model',
        displayName: 'Ctx',
        contextWindow: 123,
        capabilities: { vision: false, toolUse: true, reasoning: false },
      },
    ]
    expect(applyModelMetaUpdate(custom)).toBe(true)
    expect(findModelMeta('ctx-test-model')?.contextWindow).toBe(123)
  })
})
```

- [ ] **Step 2: 运行测试验证失败**

Run: `bun test apps/web/src/lib/model-meta-context.test.ts`
Expected: FAIL — `./model-meta-context` 不存在。

- [ ] **Step 3: 实现 Context**

创建 `apps/web/src/lib/model-meta-context.tsx`（遵循 `thread-file-env.tsx` 范式：Context 私有、默认值无 throw 守卫）：

```tsx
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react"
import { getModelMeta } from "@/lib/desktop-api/model"
import { setModelMeta, type ModelMeta } from "@lume/shared"

interface ModelMetaContextValue {
  /** registry 版本号；setModelMeta 后 bump，消费者 useMemo 依赖它触发重算 */
  version: number
  /** 重新加载：传入 generated 直接用，不传则 getModelMeta 拉取；成功后 bump version */
  reload: (generated?: ModelMeta[]) => Promise<void>
}

const ModelMetaContext = createContext<ModelMetaContextValue>({
  version: 0,
  reload: async () => {},
})

/**
 * 应用 generated 更新：非空 → setModelMeta + 返回 true（调用方 bump version）；
 * null → 返回 false（保持 seed，不 bump）。
 * 抽成纯函数便于单测（无需 DOM）。
 */
export function applyModelMetaUpdate(generated: ModelMeta[] | null): boolean {
  if (!generated) return false
  setModelMeta(generated)
  return true
}

export function ModelMetaProvider({ children }: { children: ReactNode }) {
  const [version, setVersion] = useState(0)

  const reload = useCallback(async (generated?: ModelMeta[]) => {
    const data = generated ?? (await getModelMeta())
    if (applyModelMetaUpdate(data)) {
      setVersion((v) => v + 1)
    }
  }, [])

  // 启动加载（seed 优先）：mount 时异步拉 config dir 数据覆盖 seed；失败保持 seed
  useEffect(() => {
    void reload().catch(() => {
      // sidecar 未就绪/超时/损坏 → 保持 seed，不 bump
    })
  }, [reload])

  const value = useMemo<ModelMetaContextValue>(() => ({ version, reload }), [version, reload])
  return <ModelMetaContext.Provider value={value}>{children}</ModelMetaContext.Provider>
}

/** 消费者用：放入 useMemo 依赖数组，reload 后触发重算 */
export function useModelMetaVersion(): number {
  return useContext(ModelMetaContext).version
}

/** 子项目 B 按钮用：sync 成功后传 newGenerated 触发 setModelMeta + bump */
export function useModelMetaReload(): (generated?: ModelMeta[]) => Promise<void> {
  return useContext(ModelMetaContext).reload
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `bun test apps/web/src/lib/model-meta-context.test.ts`
Expected: PASS（3 个用例）。

- [ ] **Step 5: web typecheck**

Run: `cd apps/web && bunx tsc -p tsconfig.json --noEmit`
Expected: 无错误。

- [ ] **Step 6: Commit**（需用户确认）

```bash
git add apps/web/src/lib/model-meta-context.tsx apps/web/src/lib/model-meta-context.test.ts
git commit -m "✨ feat(web): ModelMetaContext（Provider + version + reload，seed 优先启动加载）"
```

---

### Task 7: web — App 根挂 ModelMetaProvider

**Files:**
- Modify: `apps/web/src/App.tsx:93-100`

**Interfaces:**
- Consumes: `ModelMetaProvider`（Task 6）

> 说明：纯结构改动（Provider 嵌套），无逻辑测试。靠 Task 9 集成验证。

- [ ] **Step 1: 挂载 Provider**

修改 `apps/web/src/App.tsx`。在文件顶部 import 区加：

```tsx
import { ModelMetaProvider } from "@/lib/model-meta-context"
```

把 L93-100 的 Provider 树从：

```tsx
  return (
    <Provider>
      <TooltipProvider>
        <AppInner />
        <Toaster position="bottom-right" />
      </TooltipProvider>
    </Provider>
  )
```

改为（`ModelMetaProvider` 在 jotai `Provider` 内、`TooltipProvider` 外——数据层聚拢）：

```tsx
  return (
    <Provider>
      <ModelMetaProvider>
        <TooltipProvider>
          <AppInner />
          <Toaster position="bottom-right" />
        </TooltipProvider>
      </ModelMetaProvider>
    </Provider>
  )
```

- [ ] **Step 2: web typecheck**

Run: `cd apps/web && bunx tsc -p tsconfig.json --noEmit`
Expected: 无错误。

- [ ] **Step 3: Commit**（需用户确认）

```bash
git add apps/web/src/App.tsx
git commit -m "✨ feat(web): App 根挂 ModelMetaProvider"
```

---

### Task 8: web — 6 处消费者接入 useModelMetaVersion

**Files:**
- Modify: `apps/web/src/components/agent/AgentInput.tsx:535`
- Modify: `apps/web/src/components/agent/ModelPicker.tsx:134,156`
- Modify: `apps/web/src/components/settings/AgentSettings.tsx:1074`
- Modify: `apps/web/src/components/settings/DefaultModelStrategyPanel.tsx:373`
- Modify: `apps/web/src/components/settings/SubagentDefaultModelPanel.tsx:91`
- Modify: `apps/web/src/components/welcome/WelcomeModelPicker.tsx:99,144,167`

**Interfaces:**
- Consumes: `useModelMetaVersion()`（Task 6）

**通用改法（两种形态）**：

**形态 A — `useMemo` 调用**（ModelPicker / AgentInput / DefaultModelStrategyPanel / SubagentDefaultModelPanel / WelcomeModelPicker 的 useMemo 处）：组件内加 `const modelMetaVersion = useModelMetaVersion()`，并在该 `useMemo` 依赖数组追加 `modelMetaVersion`。

代表（`ModelPicker.tsx:134`）before：
```tsx
  const groups = useMemo(() => buildModelSelectionGroups({
    channels,
    activeChannelId: baseChannelId,
    activeModelRef: baseModelRef,
  }), [channels, baseChannelId, baseModelRef])
```
after：
```tsx
  const modelMetaVersion = useModelMetaVersion()
  const groups = useMemo(() => buildModelSelectionGroups({
    channels,
    activeChannelId: baseChannelId,
    activeModelRef: baseModelRef,
  }), [channels, baseChannelId, baseModelRef, modelMetaVersion])
```
同组件内 `ModelPicker.tsx:156` 的 `summary` useMemo 依赖数组也追加 `modelMetaVersion`（变量已定义，复用）。

**形态 B — render 内直接调用**（`AgentSettings.tsx:1074`，`findModelMeta` 在模块函数 `buildContextWindowRows` 内，组件 render 时直接调用）：组件内加 `useModelMetaVersion()` 建立重渲染依赖。

`AgentSettings.tsx:1074` before：
```tsx
  const rows = buildContextWindowRows(chatOptions, contextWindows)
```
after：
```tsx
  const modelMetaVersion = useModelMetaVersion()
  // model 元数据 reload 后触发组件重渲染（buildContextWindowRows 读全局 registry，version 变即重算）
  void modelMetaVersion
  const rows = buildContextWindowRows(chatOptions, contextWindows)
```

- [ ] **Step 1: 每个文件加 import**

在 6 个文件各自的 import 区加（路径按文件位置调整：`@/lib/model-meta-context`）：

```tsx
import { useModelMetaVersion } from "@/lib/model-meta-context"
```

- [ ] **Step 2: AgentInput.tsx — useMemo 加依赖**

`apps/web/src/components/agent/AgentInput.tsx`：在组件内 `useMemo(() => getThreadSelectionSummary({...}), [...])`（L535）之前加 `const modelMetaVersion = useModelMetaVersion()`，并在依赖数组追加 `modelMetaVersion`。

- [ ] **Step 3: ModelPicker.tsx — 两个 useMemo 加依赖**

`apps/web/src/components/agent/ModelPicker.tsx`：L134 `groups` 与 L156 `summary` 两个 useMemo 均追加 `modelMetaVersion`（按形态 A，变量定义一次复用）。

- [ ] **Step 4: AgentSettings.tsx — render 调用加重渲染依赖**

`apps/web/src/components/settings/AgentSettings.tsx`：L1074 前按形态 B 加 `useModelMetaVersion()` + `void modelMetaVersion`。

- [ ] **Step 5: DefaultModelStrategyPanel.tsx — useMemo 加依赖**

`apps/web/src/components/settings/DefaultModelStrategyPanel.tsx`：L373 `buildModelSelectionGroups` useMemo 按形态 A 加 `modelMetaVersion`。

- [ ] **Step 6: SubagentDefaultModelPanel.tsx — useMemo 加依赖**

`apps/web/src/components/settings/SubagentDefaultModelPanel.tsx`：L91 `buildModelSelectionGroups` useMemo 按形态 A 加 `modelMetaVersion`。

- [ ] **Step 7: WelcomeModelPicker.tsx — 多处加依赖**

`apps/web/src/components/welcome/WelcomeModelPicker.tsx`：L99 / L144 / L167 的 `buildModelSelectionGroups` / `getThreadSelectionSummary` 调用，`useMemo` 的按形态 A 加依赖；若 L99 是直接调用（非 useMemo）则按形态 B 加 `useModelMetaVersion()` 重渲染依赖。实现时逐处确认是否 useMemo（grep `useMemo` 上下文）。

- [ ] **Step 8: web typecheck**

Run: `cd apps/web && bunx tsc -p tsconfig.json --noEmit`
Expected: 无错误（所有 `useModelMetaVersion` 调用点类型正确）。

- [ ] **Step 9: 既有组件测试回归**

Run: `bun test apps/web/src/components/agent/AgentView.test.tsx apps/web/src/components/model-selection/model-selection-state.test.ts`
Expected: PASS（既有测试不因加 hook 依赖而破坏；`model-selection-state.test.ts` 测纯函数，不受影响）。

- [ ] **Step 10: Commit**（需用户确认）

```bash
git add apps/web/src/components/agent/AgentInput.tsx apps/web/src/components/agent/ModelPicker.tsx apps/web/src/components/settings/AgentSettings.tsx apps/web/src/components/settings/DefaultModelStrategyPanel.tsx apps/web/src/components/settings/SubagentDefaultModelPanel.tsx apps/web/src/components/welcome/WelcomeModelPicker.tsx
git commit -m "✨ feat(web): 6 处 model 元数据消费者接入 useModelMetaVersion"
```

---

### Task 9: 集成验证

**Files:** 无改动（仅运行验证）

- [ ] **Step 1: 全端 typecheck**

Run: `cd packages/shared && bunx tsc -p tsconfig.json --noEmit && cd ../../apps/sidecar && bunx tsc -p tsconfig.json --noEmit && cd ../web && bunx tsc -p tsconfig.json --noEmit`
Expected: 三端均无错误。

- [ ] **Step 2: 全端测试**

Run: `bun test packages/shared/src/data packages/shared/src/types/model-meta.test.ts apps/sidecar/src/rpc/model-meta-handlers.test.ts apps/web/src/lib/model-meta-context.test.ts`
Expected: 全部 PASS。

- [ ] **Step 3: 启动 app 验证 seed 加载**

Run: 启动桌面 app（`pnpm dev` 或项目启动脚本）。打开任意含模型选择的界面（如设置 → 默认模型策略 / 新建会话 ModelPicker）。
Expected: 模型列表正常显示（seed 数据立即可用，无 loading 闪烁）。contextWindow / pricing 显示正常。

- [ ] **Step 4: 验证 sidecar GET 工作（手动写 config dir 文件）**

向 config dir 写入一个测试 generated.json（内容含一个 seed 里没有的模型 id），然后重启 app：

```bash
# PowerShell（示例，路径按实际 config dir）
'[{ "id": "manual-test-model", "displayName": "Manual Test", "contextWindow": 555, "capabilities": { "vision": false, "toolUse": false, "reasoning": false } }]' | Set-Content "$env:USERPROFILE\.lume\model-meta.generated.json"
```

重启 app 后，在模型选择界面验证 `manual-test-model` 的 contextWindow 显示为 555（说明 sidecar GET 返回了 config dir 数据，覆盖了 seed）。
Expected: config dir 数据生效。

- [ ] **Step 5: 验证 ENOENT fallback（删 config dir 文件）**

删除 `$env:USERPROFILE\.lume\model-meta.generated.json`，重启 app。
Expected: 模型列表回退到 seed（无崩溃，无报错 toast）。

- [ ] **Step 6: 验证 reload 感知（手动触发）**

> 子项目 B 的按钮尚未实现，故用 dev console 手动触发 reload 验证 A 的 reload 通道。

在 app 的 dev console 执行（模拟 B 的按钮逻辑）：

```js
// 通过 React DevTools 或测试 hook 拿到 reload；或临时在 window 暴露
// 简化：直接改 config dir 文件后调 reload
```

由于 `useModelMetaReload` 未在 window 暴露，本步可推迟到子项目 B 实现时联合验证；A 阶段验证 Step 3-5 即可（seed 加载 + GET 覆盖 + ENOENT fallback），reload 感知的完整链路由 B 的按钮端到端验证。

- [ ] **Step 7: 可选 — invoke verify skill**

Run: `/verify`（若需更正式的端到端验证记录）
Expected: verify 通过。

---

## Self-Review

**1. Spec coverage**（逐节对照 spec）：

| Spec 章节 | 覆盖 Task |
|---|---|
| §1 背景/现状 | 无需实现（背景） |
| §2 目标 — mutable registry | Task 1 |
| §2 目标 — web 启动拉取 | Task 5+6+7 |
| §2 目标 — reload 消费者重算 | Task 6+8 |
| §2 目标 — seed fallback | Task 1（MODEL_META_SEED）+ Task 4（ENOENT→null）+ Task 9 Step 5 |
| §3 决策 1 sidecar IPC | Task 4+5 |
| §3 决策 2 加载语义 | Task 1+6 |
| §3 决策 3 seed 优先 bootstrap | Task 6（mount 异步覆盖，不阻塞）+ Task 9 Step 3 |
| §3 决策 4 sidecar 无状态 | Task 4（handler 无 registry） |
| §3 决策 5 pull 模式 | Task 6（reload 内 getModelMeta，无 push 通道） |
| §3 决策 6 merge 单一 web 侧 | Task 1（setModelMeta 内 merge）+ Task 4（返回未 merge） |
| §4.1 config dir + seed 双层 | Task 1（seed）+ Task 4（config dir 读） |
| §4.2 三条数据流 | Task 6+9（①启动）；Task 6 reload 为 ②同步更新基础（B 完善）；③运行时查询零改动（Task 1 保证） |
| §4.3 version Context | Task 6+8 |
| §5 组件改动清单 | Task 1-8 逐项对应 |
| §6 sidecar handler + 错误矩阵 | Task 4 + 测试覆盖 ENOENT/损坏 |
| §7 测试策略 | Task 1/2/4/6 测试 + Task 9 集成 |
| §8 A/B 边界 | 本计划仅 A；B（SYNC handler + 按钮）未包含，Task 6 预留 `useModelMetaReload` |
| §9 待 plan 实证 4 点 | ①枚举落 `types/model-meta.ts`（Task 3）✓；②Provider 挂载 jotai 内 TooltipProvider 外（Task 7）✓；③并发守卫——JS 单线程 let 引用替换原子，无需锁（Task 1 实现）✓；④hook 形态——`useModelMetaVersion` + `useModelMetaReload`（Task 6）✓ |

**2. Placeholder scan**：无 TBD/TODO；Task 8 Step 7 对 WelcomeModelPicker L99 是否 useMemo 给了「实现时 grep 确认」的明确指令（非占位，是因该行未读取上下文，给定位方法）。Task 9 Step 6 明确标注「A 阶段验证 Step 3-5 即可，reload 完整链路 B 联合验证」（非占位，是合理的阶段边界）。

**3. Type consistency**：
- `setModelMeta(generated: ModelMeta[]): void` — Task 1 定义，Task 6 消费（`applyModelMetaUpdate` 调用）✓
- `MODEL_META_SEED: ModelMeta[]` — Task 1 定义，Task 1 测试 + Task 6 测试消费 ✓
- `getModelMeta(): Promise<ModelMeta[] | null>` — Task 5 定义，Task 6 消费 ✓
- `createModelMetaHandlers(): Record<string, RpcHandler>` — Task 4 定义，Task 4 聚合消费 ✓
- `MODEL_META_IPC_CHANNELS.GET` — Task 3 定义，Task 4+5 消费 ✓
- `applyModelMetaUpdate(generated: ModelMeta[] | null): boolean` — Task 6 定义 + 测试 ✓
- `useModelMetaVersion(): number` / `useModelMetaReload()` — Task 6 定义，Task 8 消费 ✓
- handler 返回 `ModelMeta[] | null`（未 merge）— Task 4 实现 + 测试 + Task 5 类型一致 ✓

无类型不一致。Plan 与 spec 自洽。
