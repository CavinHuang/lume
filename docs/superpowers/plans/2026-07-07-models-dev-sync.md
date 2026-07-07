# models.dev 构建期同步 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用构建期同步脚本从 models.dev 自动生成模型元数据，替代手工维护的 `MODEL_META_REGISTRY`，同时保留中文描述/别名/国产缺口模型。

**Architecture:** 三层数据——`model-meta.generated.json`（脚本生成）+ `model-meta.override.ts`（人工稳定层）经纯函数 `mergeModelMeta` 合并；`model-meta.ts` 公开 API 零变更，现有 14 个测试作回归护栏。

**Tech Stack:** TypeScript（`"type": "module"`）、bun（workspace + `bun:test` + 直接跑 `.ts` 脚本）、`resolveJsonModule: true`（已启用）。

## Global Constraints

- 测试运行器：`bun:test`（**非 vitest**）。shared 包测试命令：`cd packages/shared && bun test`（当前 shared/package.json 缺 `test` script，Task 5 补）。
- 公开 API 零变更：`findModelMeta` / `inferCapabilities` / `formatContextWindow` / `formatPricing` 的签名与匹配行为不可改，现有 14 个 `model-meta.test.ts` 用例必须全程通过。
- `@lume/shared` 的 `main`/`types` 指向 `./src/index.ts`（源码即产物），generated.json 必须放 `src/data/` 下以被 import。
- 定价单位：models.dev `cost.input/output` = USD / 1M tokens，与本地 `ModelPricing` 一致，**禁止任何单位换算**。
- 提交信息使用 emoji 前缀（项目约定）。
- **禁止 git 提交/分支操作，除非用户明确要求**（项目 CLAUDE.md）。计划中的 commit step 仅在用户授权执行阶段才执行。

## File Structure

| 文件 | 责任 | 任务 |
|---|---|---|
| `packages/shared/src/data/merge-models.ts` | 纯函数 `mergeModelMeta` + `ModelOverride` 消费 | Task 1 |
| `packages/shared/src/data/merge-models.test.ts` | `mergeModelMeta` 单测 | Task 1 |
| `packages/shared/src/data/model-meta.override.ts` | `ModelOverride` 类型定义 + 人工稳定层数据 | Task 1（骨架）/ Task 4（填充） |
| `packages/shared/scripts/sync-models.ts` | 同步脚本：fetch catalog → 映射 → 写 generated.json | Task 2 |
| `packages/shared/scripts/sync-models.test.ts` | 映射纯函数单测 | Task 2 |
| `packages/shared/src/data/model-meta.generated.json` | 机器生成产物（git tracked） | Task 3 |
| `packages/shared/src/data/model-meta.ts` | 改造：删硬编码 registry，改用 generated+override merge | Task 5 |
| `packages/shared/package.json` | 补 `test` 与 `sync:models` script | Task 5 |

---

### Task 1: mergeModelMeta 纯函数 + ModelOverride 类型

**Files:**
- Create: `packages/shared/src/data/model-meta.override.ts`
- Create: `packages/shared/src/data/merge-models.ts`
- Test: `packages/shared/src/data/merge-models.test.ts`

**Interfaces:**
- Consumes: `ModelMeta` / `ModelCapabilities` / `ModelPricing`（来自现有 `model-meta.ts`，未改造）
- Produces:
  - `ModelOverride`（`model-meta.override.ts` 导出的接口）
  - `MODEL_OVERRIDES: Record<string, ModelOverride>`（空骨架，Task 4 填充）
  - `mergeModelMeta(generated: ModelMeta[], overrides: Record<string, ModelOverride>): ModelMeta[]`

- [ ] **Step 1: 创建 override 骨架文件（含类型定义）**

创建 `packages/shared/src/data/model-meta.override.ts`：

```ts
/**
 * 人工稳定层 —— sync-models 脚本永不写入此文件。
 * 仅放：中文 description / aliases / 国产缺口模型 / 字段修正。
 */

/** 对 generated 条目的覆盖项；全字段可选。 */
export interface ModelOverride {
  displayName?: string
  contextWindow?: number
  capabilities?: Partial<{ vision: boolean; toolUse: boolean; reasoning: boolean }>
  pricing?: { input: number; output: number }
  description?: string
  aliases?: string[]
}

/**
 * Task 4 将填充真实内容。当前为空骨架，保证 model-meta.ts 接线后行为等价于纯 generated。
 */
export const MODEL_OVERRIDES: Record<string, ModelOverride> = {}
```

- [ ] **Step 2: 写失败测试**

创建 `packages/shared/src/data/merge-models.test.ts`：

```ts
import { describe, expect, test } from 'bun:test'
import type { ModelMeta } from './model-meta'
import { mergeModelMeta } from './merge-models'
import type { ModelOverride } from './model-meta.override'

const base = (id: string, over: Partial<ModelMeta> = {}): ModelMeta => ({
  id,
  displayName: id,
  contextWindow: 1000,
  capabilities: { vision: false, toolUse: true, reasoning: false },
  ...over,
})

describe('mergeModelMeta', () => {
  test('override 覆盖 generated 标量字段', () => {
    const generated = [base('m1')]
    const overrides: Record<string, ModelOverride> = { m1: { displayName: '新名', contextWindow: 9999 } }
    const [m] = mergeModelMeta(generated, overrides)
    expect(m.displayName).toBe('新名')
    expect(m.contextWindow).toBe(9999)
  })

  test('capabilities 按分量合并（override 仅覆盖指定分量）', () => {
    const generated = [base('m1', { capabilities: { vision: true, toolUse: true, reasoning: false } })]
    const overrides: Record<string, ModelOverride> = { m1: { capabilities: { reasoning: true } } }
    const [m] = mergeModelMeta(generated, overrides)
    expect(m.capabilities).toEqual({ vision: true, toolUse: true, reasoning: true })
  })

  test('pricing 整体替换', () => {
    const generated = [base('m1', { pricing: { input: 3, output: 15 } })]
    const overrides: Record<string, ModelOverride> = { m1: { pricing: { input: 1, output: 2 } } }
    const [m] = mergeModelMeta(generated, overrides)
    expect(m.pricing).toEqual({ input: 1, output: 2 })
  })

  test('aliases 取并集去重，generated 在前', () => {
    const generated = [base('m1', { aliases: ['a', 'b'] })]
    const overrides: Record<string, ModelOverride> = { m1: { aliases: ['b', 'c'] } }
    const [m] = mergeModelMeta(generated, overrides)
    expect(m.aliases).toEqual(['a', 'b', 'c'])
  })

  test('override 独有 id 作为新条目追加（standalone）', () => {
    const generated = [base('m1')]
    const overrides: Record<string, ModelOverride> = {
      m2: { displayName: '缺口模型', contextWindow: 8000, capabilities: { toolUse: true, reasoning: true } },
    }
    const result = mergeModelMeta(generated, overrides)
    expect(result.map((m) => m.id)).toEqual(['m1', 'm2'])
    const m2 = result[1]
    expect(m2.displayName).toBe('缺口模型')
    expect(m2.contextWindow).toBe(8000)
    // 未指定的 capability 分量补 false
    expect(m2.capabilities).toEqual({ vision: false, toolUse: true, reasoning: true })
  })

  test('无 override 的 generated 条目保持不变', () => {
    const generated = [base('m1', { description: '原描述' })]
    const result = mergeModelMeta(generated, {})
    expect(result[0]).toEqual(generated[0])
  })

  test('override 既无 aliases 又无 generated aliases 时，结果无 aliases 字段', () => {
    const generated = [base('m1')]
    const overrides: Record<string, ModelOverride> = { m1: { description: 'x' } }
    const [m] = mergeModelMeta(generated, overrides)
    expect(m.aliases).toBeUndefined()
  })
})
```

- [ ] **Step 3: 运行测试确认失败**

Run: `cd packages/shared && bun test src/data/merge-models.test.ts`
Expected: FAIL（`Cannot find module './merge-models'`）

- [ ] **Step 4: 实现 mergeModelMeta**

创建 `packages/shared/src/data/merge-models.ts`：

```ts
import type { ModelCapabilities, ModelMeta, ModelPricing } from './model-meta'
import type { ModelOverride } from './model-meta.override'

/** 并集去重 aliases，generated 在前；两者皆空返回 undefined。 */
function unionAliases(generated?: string[], override?: string[]): string[] | undefined {
  if (!generated && !override) return undefined
  const seen = new Set<string>()
  const out: string[] = []
  for (const alias of [...(generated ?? []), ...(override ?? [])]) {
    if (!seen.has(alias)) {
      seen.add(alias)
      out.push(alias)
    }
  }
  return out.length ? out : undefined
}

/** 用 override 深合并一个 generated 条目。 */
function applyOverride(meta: ModelMeta, override: ModelOverride): ModelMeta {
  const merged: ModelMeta = {
    ...meta,
    capabilities: { ...meta.capabilities, ...(override.capabilities ?? {}) },
    aliases: unionAliases(meta.aliases, override.aliases),
  }
  if (override.displayName !== undefined) merged.displayName = override.displayName
  if (override.contextWindow !== undefined) merged.contextWindow = override.contextWindow
  if (override.description !== undefined) merged.description = override.description
  if (override.pricing !== undefined) merged.pricing = override.pricing
  return merged
}

/** 由 override 构造 standalone 条目（generated 中不存在）。未指定的 capability 分量补 false。 */
function overrideToStandalone(id: string, ov: ModelOverride): ModelMeta {
  const meta: ModelMeta = {
    id,
    displayName: ov.displayName ?? id,
    contextWindow: ov.contextWindow ?? 0,
    capabilities: { vision: false, toolUse: false, reasoning: false, ...(ov.capabilities ?? {}) },
  }
  if (ov.description !== undefined) meta.description = ov.description
  if (ov.pricing !== undefined) meta.pricing = ov.pricing
  if (ov.aliases !== undefined && ov.aliases.length) meta.aliases = ov.aliases
  return meta
}

/**
 * 合并 generated 与 override：
 * 1) generated 每条应用同 id override（深合并）；
 * 2) override 中 generated 没有的 id 作为 standalone 追加。
 */
export function mergeModelMeta(
  generated: ModelMeta[],
  overrides: Record<string, ModelOverride>,
): ModelMeta[] {
  const merged = generated.map((m) => (overrides[m.id] ? applyOverride(m, overrides[m.id]) : m))
  const generatedIds = new Set(generated.map((m) => m.id))
  for (const [id, ov] of Object.entries(overrides)) {
    if (!generatedIds.has(id)) merged.push(overrideToStandalone(id, ov))
  }
  return merged
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd packages/shared && bun test src/data/merge-models.test.ts`
Expected: PASS（7 tests）

- [ ] **Step 6: 确认现有 model-meta 测试未受影响**

Run: `cd packages/shared && bun test src/data/model-meta.test.ts`
Expected: PASS（14 tests，回归护栏）

- [ ] **Step 7: 类型检查**

Run: `cd packages/shared && bun run typecheck`
Expected: 无错误

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/data/merge-models.ts packages/shared/src/data/merge-models.test.ts packages/shared/src/data/model-meta.override.ts
git commit -m "✨ feat(shared): 新增 mergeModelMeta 纯函数与 ModelOverride 类型"
```

---

### Task 2: sync-models 同步脚本（含映射纯函数）

**Files:**
- Create: `packages/shared/scripts/sync-models.ts`
- Test: `packages/shared/scripts/sync-models.test.ts`

**Interfaces:**
- Consumes: `ModelMeta` / `ModelCapabilities` / `ModelPricing`（来自 `../src/data/model-meta`）
- Produces:
  - `WHITELIST_PROVIDERS`（13 个 provider，canonical 优先级）
  - `buildGeneratedFromCatalog(catalog: Catalog): ModelMeta[]`（纯函数，可测）
  - `main()`（fetch + write，由 `Bun.main` 守卫触发）

- [ ] **Step 1: 写失败测试**

创建 `packages/shared/scripts/sync-models.test.ts`：

```ts
import { describe, expect, test } from 'bun:test'
import type { ModelMeta } from '../src/data/model-meta'
import { buildGeneratedFromCatalog } from './sync-models'
import type { Catalog } from './sync-models'

const mkModel = (over: Record<string, unknown>) => over

const miniCatalog: Catalog = {
  providers: {
    // 官方 provider：应收录
    openai: {
      models: {
        'gpt-5.2': mkModel({
          name: 'GPT-5.2',
          description: 'Reliable GPT generation',
          attachment: true,
          reasoning: true,
          tool_call: true,
          modalities: { input: ['text', 'image'], output: ['text'] },
          limit: { context: 400000, output: 128000 },
          cost: { input: 1.75, output: 14, cache_read: 0.175 },
        }),
        'gpt-5.2-no-cost': mkModel({
          name: 'GPT-5.2 NoCost',
          tool_call: true,
          limit: { context: 128000 },
          // 无 cost 字段
        }),
      },
    },
    anthropic: {
      models: {
        'claude-sonnet-4-5': mkModel({
          name: 'Claude Sonnet 4.5',
          attachment: true,
          reasoning: true,
          tool_call: true,
          modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
          limit: { context: 200000, output: 64000 },
          cost: { input: 3, output: 15 },
        }),
      },
    },
    // 聚合器：不在白名单，不应收录
    openrouter: {
      models: {
        'some-aggregated-model': mkModel({ name: 'X', tool_call: true, limit: { context: 8000 } }),
      },
    },
    // 缺 limit.context 的模型：应被跳过
    deepseek: {
      models: {
        'bad-model': mkModel({ name: 'Bad', tool_call: true }),
      },
    },
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
    const claude = result.find((m) => m.id === 'claude-sonnet-4-5') as ModelMeta
    expect(claude.capabilities.vision).toBe(true)
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

  test('结果按 id 字典序排序（保证 diff 稳定）', () => {
    const ids = result.map((m) => m.id)
    const sorted = [...ids].sort()
    expect(ids).toEqual(sorted)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/shared && bun test scripts/sync-models.test.ts`
Expected: FAIL（`Cannot find module './sync-models'`）

- [ ] **Step 3: 实现脚本**

创建 `packages/shared/scripts/sync-models.ts`：

```ts
import { writeFileSync } from 'node:fs'
import type { ModelCapabilities, ModelMeta, ModelPricing } from '../src/data/model-meta'

const CATALOG_URL = 'https://models.dev/catalog.json'
const OUTPUT_PATH = new URL('../src/data/model-meta.generated.json', import.meta.url)

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
    console.warn(`[sync-models] skip "${modelId}": missing limit.context or name`)
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
      console.warn(`[sync-models] provider "${providerId}" not in catalog, skipping`)
      continue
    }
    for (const [modelId, m] of Object.entries(provider.models)) {
      if (seen.has(modelId)) continue // canonical-priority 去重
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

async function fetchCatalog(): Promise<Catalog> {
  const res = await fetch(CATALOG_URL)
  if (!res.ok) throw new Error(`fetch ${CATALOG_URL}: HTTP ${res.status}`)
  return (await res.json()) as Catalog
}

async function main(): Promise<void> {
  const catalog = await fetchCatalog()
  const generated = buildGeneratedFromCatalog(catalog)
  // 不直接写 OUTPUT_PATH：先写到临时变量，序列化成功后再落盘，避免中途失败污染现有文件
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

- [ ] **Step 4: 运行测试确认通过**

Run: `cd packages/shared && bun test scripts/sync-models.test.ts`
Expected: PASS（8 tests）

- [ ] **Step 5: 类型检查**

Run: `cd packages/shared && bun run typecheck`
Expected: 无错误（注：scripts/ 不在 tsconfig 的 include 内，见 Step 6）

- [ ] **Step 6: 确认 scripts/ 被 typecheck 覆盖**

检查 `packages/shared/tsconfig.json` 的 `include` 是否含 `scripts/**/*`。若不含，本步**不修改 tsconfig**（保持 src 编译边界干净），改为在 Step 4 的 bun test 已覆盖类型错误兜底。若 reviewer 认为需要 scripts 类型检查，可在 tsconfig 增加 `scripts/**/*` 到 include——此为可选，默认不做。

- [ ] **Step 7: Commit**

```bash
git add packages/shared/scripts/sync-models.ts packages/shared/scripts/sync-models.test.ts
git commit -m "✨ feat(shared): 新增 models.dev 同步脚本 sync-models"
```

---

### Task 3: 首次运行同步生成 generated.json

**Files:**
- Create: `packages/shared/src/data/model-meta.generated.json`（脚本产物）

**Interfaces:**
- Consumes: Task 2 的 `sync-models.ts`
- Produces: `model-meta.generated.json`（真实数据快照，供 Task 5 import）

- [ ] **Step 1: 运行同步脚本**

Run: `cd packages/shared && bun run scripts/sync-models.ts`
Expected: 控制台输出 `[sync-models] wrote N models → .../model-meta.generated.json`（N 约 100+）

- [ ] **Step 2: 验证产物关键抽样**

Run（校验定价单位与新模型存在）:

```bash
cd packages/shared && jq '.[] | select(.id=="gpt-5.2") | .pricing' src/data/model-meta.generated.json && jq '.[] | select(.id=="claude-sonnet-4-5") | .pricing' src/data/model-meta.generated.json && jq '.[] | select(.id=="glm-5.2") | {id,contextWindow,pricing}' src/data/model-meta.generated.json
```

Expected:
- `gpt-5.2` pricing = `{ "input": 1.75, "output": 14 }`
- `claude-sonnet-4-5` pricing = `{ "input": 3, "output": 15 }`
- `glm-5.2` 存在，contextWindow = 1000000，pricing 有值

- [ ] **Step 3: 验证白名单过滤生效（无聚合器模型）**

Run: `cd packages/shared && jq '[.[].id] | length' src/data/model-meta.generated.json`
Expected: 条目数 < catalog 总量，且不含 openrouter 等聚合器独有模型。

- [ ] **Step 4: 验证幂等（再跑一次无 diff）**

Run:
```bash
cd packages/shared && cp src/data/model-meta.generated.json /tmp/gen-before.json && bun run scripts/sync-models.ts >/dev/null 2>&1 && diff /tmp/gen-before.json src/data/model-meta.generated.json && echo "IDEMPOTENT"
```
Expected: 输出 `IDEMPOTENT`（diff 为空）。若 models.dev 数据在此期间变化导致 diff，属正常，记录后继续。

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/data/model-meta.generated.json
git commit -m " Chore(shared): 首次同步生成 model-meta.generated.json"
```

（commit message 的 emoji 按项目惯例选取，如 `📦 chore`。）

---

### Task 4: 填充 override（中文定制 + 国产缺口）

**Files:**
- Modify: `packages/shared/src/data/model-meta.override.ts`（替换 Task 1 的空 `MODEL_OVERRIDES`）

**Interfaces:**
- Consumes: Task 1 的 `ModelOverride` 类型；现有 `MODEL_META_REGISTRY`（原 `model-meta.ts`，作迁移源，尚未删除）
- Produces: 填充后的 `MODEL_OVERRIDES`

**迁移规则**（基于现有 registry 与 models.dev 白名单覆盖度的交叉核对）：
1. **人工定制**（generated 会覆盖同 id，仅补字段）：原 registry 中带中文 `description` 或 `aliases` 的条目，按 id 提取 `description` / `aliases`。
2. **国产缺口**（generated 无，作 standalone）：原 registry 中 models.dev 白名单未收录的模型（doubao 全系、moonshot-v1/kimi-latest、老 glm-4-*/glm-z1-*、qwen-long/qwq-32b、step-router-v1、minimax-text-01），完整搬移 `displayName` / `contextWindow` / `capabilities` / `description` / `aliases`。
3. 不搬移 pricing（交给 generated 维护）；不搬移 qwen-max/plus/turbo/vl-max 与 glm-4.5+（generated 已覆盖）。

- [ ] **Step 1: 用填充内容替换 override 文件**

将 `packages/shared/src/data/model-meta.override.ts` 的内容整体替换为：

```ts
/**
 * 人工稳定层 —— sync-models 脚本永不写入此文件。
 * 1) 人工定制：补中文 description / aliases（generated 覆盖同 id，仅补字段）
 * 2) 国产缺口：models.dev 白名单未收录（generated 无，作 standalone 条目）
 */

/** 对 generated 条目的覆盖项；全字段可选。 */
export interface ModelOverride {
  displayName?: string
  contextWindow?: number
  capabilities?: Partial<{ vision: boolean; toolUse: boolean; reasoning: boolean }>
  pricing?: { input: number; output: number }
  description?: string
  aliases?: string[]
}

export const MODEL_OVERRIDES: Record<string, ModelOverride> = {
  // ── 1. 人工定制（generated 覆盖，补 description / aliases）──
  'claude-sonnet-4-20250514': {
    description: '擅长代码和日常任务',
    aliases: ['claude-sonnet-4', 'claude-3-5-sonnet', 'claude-3-5-sonnet-20241022', 'claude-3.5-sonnet', 'anthropic/claude-sonnet-4-5'],
  },
  'claude-opus-4-20250514': {
    description: '最强推理能力',
    aliases: ['claude-opus-4', 'claude-3-opus', 'claude-3-opus-20240229'],
  },
  'claude-haiku-4-5-20251001': {
    aliases: ['claude-haiku-4-5', 'claude-3-5-haiku', 'claude-3-5-haiku-20241022'],
  },
  'claude-sonnet-4-5': { aliases: ['claude-3-5-sonnet-20241022'] },
  'gpt-4o': { aliases: ['gpt-4o-2024-11-20', 'gpt-4o-2024-08-06'] },
  'gpt-4o-mini': { aliases: ['gpt-4o-mini-2024-07-18'] },
  'gpt-4.1-mini': { aliases: ['openai/gpt-4.1-mini'] },
  'o3': { aliases: ['o3-2025-04-16'] },
  'o3-mini': { aliases: ['o3-mini-2025-01-31'] },
  'o4-mini': { aliases: ['o4-mini-2025-04-16'] },
  'gemini-2.5-pro': {
    description: '超长上下文窗口',
    aliases: ['gemini-2.5-pro-preview-05-06'],
  },
  'gemini-2.5-flash': { aliases: ['gemini-2.5-flash-preview-05-20'] },
  'deepseek-r1': { aliases: ['deepseek-reasoner'] },
  'deepseek-chat': { aliases: ['deepseek-v3'] },
  'step-3.7-flash': { description: '阶跃星辰旗舰多模态推理模型，支持三档推理强度' },
  'step-3.5-flash-2603': { description: '针对高频 Agent 场景优化，Token 效率提升、推理速度更快' },
  'step-3.5-flash': { description: '196B MoE 架构，高速推理，专为智能体和代码任务优化' },

  // ── 2. 国产缺口（generated 无，standalone）──
  // 豆包 / 字节
  'doubao-pro-32k': { displayName: 'Doubao Pro 32K', contextWindow: 32_000, capabilities: { toolUse: true } },
  'doubao-pro-128k': { displayName: 'Doubao Pro 128K', contextWindow: 128_000, capabilities: { toolUse: true } },
  'doubao-lite-32k': { displayName: 'Doubao Lite 32K', contextWindow: 32_000, capabilities: { toolUse: true } },
  'doubao-1.5-pro': { displayName: 'Doubao 1.5 Pro', contextWindow: 128_000, capabilities: { vision: true, toolUse: true, reasoning: true } },
  'doubao-1.5-lite': { displayName: 'Doubao 1.5 Lite', contextWindow: 128_000, capabilities: { toolUse: true } },
  // Moonshot / Kimi
  'moonshot-v1-8k': { displayName: 'Moonshot V1 8K', contextWindow: 8_000, capabilities: { toolUse: true } },
  'moonshot-v1-32k': { displayName: 'Moonshot V1 32K', contextWindow: 32_000, capabilities: { toolUse: true } },
  'moonshot-v1-128k': { displayName: 'Moonshot V1 128K', contextWindow: 128_000, capabilities: { toolUse: true } },
  'kimi-latest': { displayName: 'Kimi Latest', contextWindow: 128_000, capabilities: { vision: true, toolUse: true }, aliases: ['kimi'] },
  // GLM 老款（models.dev 仅收录 glm-4.5+）
  'glm-4-plus': { displayName: 'GLM-4 Plus', contextWindow: 128_000, capabilities: { vision: true, toolUse: true } },
  'glm-4-air': { displayName: 'GLM-4 Air', contextWindow: 128_000, capabilities: { vision: true, toolUse: true } },
  'glm-4-airx': { displayName: 'GLM-4 AirX', contextWindow: 8_000, capabilities: { toolUse: true } },
  'glm-4-long': { displayName: 'GLM-4 Long', contextWindow: 1_000_000, capabilities: { toolUse: true } },
  'glm-4-flash': { displayName: 'GLM-4 Flash', contextWindow: 128_000, capabilities: { vision: true, toolUse: true }, aliases: ['glm-4-flash-250414'] },
  'glm-4-flashx': { displayName: 'GLM-4 FlashX', contextWindow: 128_000, capabilities: { toolUse: true } },
  'glm-4v': { displayName: 'GLM-4V', contextWindow: 128_000, capabilities: { vision: true, toolUse: true }, aliases: ['glm-4v-plus', 'glm-4v-flash'] },
  'glm-z1-air': { displayName: 'GLM-Z1 Air', contextWindow: 128_000, capabilities: { toolUse: true, reasoning: true } },
  'glm-z1-airx': { displayName: 'GLM-Z1 AirX', contextWindow: 8_000, capabilities: { toolUse: true, reasoning: true } },
  'glm-z1-flash': { displayName: 'GLM-Z1 Flash', contextWindow: 128_000, capabilities: { toolUse: true, reasoning: true } },
  // Qwen 老款（qwen-max/plus/turbo/vl-max 由 generated 覆盖）
  'qwen-long': { displayName: 'Qwen Long', contextWindow: 1_000_000, capabilities: { toolUse: true } },
  'qwq-32b': { displayName: 'QwQ 32B', contextWindow: 128_000, capabilities: { toolUse: true, reasoning: true }, aliases: ['qwq'] },
  // 阶跃（step-3.5/3.7 由 generated 覆盖）
  'step-router-v1': { displayName: 'Step Router V1', contextWindow: 131_072, capabilities: { toolUse: true, reasoning: true }, description: '智能路由模型，自动在 deepseek-v4-pro 与 step-3.5-flash 之间切换' },
  // MiniMax（models.dev 仅收录 MiniMax-M2 系列）
  'minimax-text-01': { displayName: 'MiniMax Text 01', contextWindow: 1_000_000, capabilities: { toolUse: true } },
}
```

- [ ] **Step 2: 类型检查**

Run: `cd packages/shared && bun run typecheck`
Expected: 无错误

- [ ] **Step 3: 单独验证 override 可被 merge（临时 sanity）**

Run（一次性 REPL 校验 override 能正常 import 且 merge 不抛错）:

```bash
cd packages/shared && bun -e "import('./src/data/merge-models').then(async m => { const o = (await import('./src/data/model-meta.override')).MODEL_OVERRIDES; const g = (await import('./src/data/model-meta.generated.json'), { assert: { type: 'json' } }); console.log('overrides:', Object.keys(o).length); })"
```

若 bun 的 JSON import 语法导致报错，改为：`bun -e "const o=require('./src/data/model-meta.override'); console.log(Object.keys(o.MODEL_OVERRIDES).length)"`，Expected: 输出 override 条目数（应为 42）。

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/data/model-meta.override.ts
git commit -m "✨ feat(shared): 填充 override 中文定制与国产缺口模型"
```

---

### Task 5: 接线 model-meta.ts + 包 scripts + 全量回归

**Files:**
- Modify: `packages/shared/src/data/model-meta.ts`
- Modify: `packages/shared/package.json`

**Interfaces:**
- Consumes: Task 1（`mergeModelMeta`）、Task 3（`model-meta.generated.json`）、Task 4（`MODEL_OVERRIDES`）
- Produces: 改造后的 `model-meta.ts`（公开 API 不变，数据源换为 generated+override）

- [ ] **Step 1: 改造 model-meta.ts 的数据源**

在 `packages/shared/src/data/model-meta.ts` 中，**保留**顶部所有 `interface` 定义（`ModelCapabilities` / `ModelPricing` / `ModelMeta`）与底部所有 `export function`（`findModelMeta` / `inferCapabilities` / `formatContextWindow` / `formatPricing`）。

仅替换中间的 `MODEL_META_REGISTRY` 常量定义（原第 35–433 行的硬编码数组）。在原 `const MODEL_META_REGISTRY: ModelMeta[] = [ ... ]` 位置替换为：

```ts
import generatedJson from './model-meta.generated.json'
import { MODEL_OVERRIDES } from './model-meta.override'
import { mergeModelMeta } from './merge-models'

/**
 * 最终注册表 = generated（models.dev 同步）⊕ override（人工稳定层）。
 * 公开 API 行为与原硬编码 registry 一致。
 */
const MODEL_META_REGISTRY: ModelMeta[] = mergeModelMeta(
  generatedJson as unknown as ModelMeta[],
  MODEL_OVERRIDES,
)
```

> 注：`import` 语句需上移到文件顶部已有 import 区（本文件原无 import，故直接置于 `interface` 定义之前）。`resolveJsonModule` 已在 `tsconfig.base.json` 启用，JSON import 可用。

- [ ] **Step 2: 运行现有 model-meta 测试（核心回归护栏）**

Run: `cd packages/shared && bun test src/data/model-meta.test.ts`
Expected: PASS（14 tests 全通过）。若某个 alias 用例失败，检查 override 中对应 aliases 是否完整迁移。

- [ ] **Step 3: 运行 merge-models 测试**

Run: `cd packages/shared && bun test src/data/merge-models.test.ts`
Expected: PASS（7 tests）

- [ ] **Step 4: 运行 shared 全量测试**

Run: `cd packages/shared && bun test`
Expected: 全部 PASS（model-meta + merge-models + 其他既有测试）

- [ ] **Step 5: 类型检查（含 JSON import 校验）**

Run: `cd packages/shared && bun run typecheck`
Expected: 无错误

- [ ] **Step 6: 补 shared/package.json 的 test 与 sync:models script**

将 `packages/shared/package.json` 的 `"scripts"` 块改为：

```json
"scripts": {
  "build": "tsc -p tsconfig.json",
  "typecheck": "tsc -p tsconfig.json --noEmit",
  "test": "bun test",
  "sync:models": "bun run scripts/sync-models.ts"
},
```

- [ ] **Step 7: 验证 pnpm/bun script 可用**

Run: `cd packages/shared && bun run sync:models`
Expected: 控制台输出 `[sync-models] wrote N models → ...`，且 `git diff src/data/model-meta.generated.json` 为空（幂等，因 Task 3 已生成相同内容）。

- [ ] **Step 8: 验证下游类型检查未被破坏**

Run: `cd "D:/workspace/projects/ai-projects/lume" && bun run typecheck`
Expected: 无错误（验证 cli/sdk/sidecar 等消费 `@lume/shared` 的包不受影响）。此步耗时较长。

- [ ] **Step 9: Commit**

```bash
git add packages/shared/src/data/model-meta.ts packages/shared/package.json
git commit -m "♻️ refactor(shared): model-meta 改用 generated+override merge，公开 API 不变"
```

---

## Self-Review（plan author 自检结果）

**1. Spec 覆盖**：
- §3 数据源（catalog.json）→ Task 2/3 ✓
- §4 架构（3 新增 + 1 改造）→ Task 1/2/4/5 ✓
- §5.1 白名单 13 provider → Task 2 `WHITELIST_PROVIDERS` ✓
- §5.2 字段映射 → Task 2 `mapModel` ✓
- §6 merge（generated+override，aliases 并集）→ Task 1 `mergeModelMeta` ✓
- §6.3 首次迁移 seed → Task 4 ✓
- §7 与 ChannelModel 不冲突 → 不触碰 ChannelModel，Task 范围确认 ✓
- §8 错误处理（网络失败不覆盖、schema 跳过 warn）→ Task 2 `mapModel` warn + `main` catch ✓
- §9 测试 → Task 1/2 单测 + Task 5 现有 14 用例回归 ✓
- §10 验证标准 → 散布于各 Task 的验证 step ✓

**2. Placeholder 扫描**：无 TBD/TODO；每个代码 step 均含完整代码；override 全表已给出（非占位）。

**3. 类型一致性**：
- `mergeModelMeta(generated: ModelMeta[], overrides: Record<string, ModelOverride>)` 在 Task 1 定义，Task 5 调用签名一致 ✓
- `ModelOverride` 在 `model-meta.override.ts` 定义，Task 1 的 `merge-models.ts` 与 Task 5 的 `model-meta.ts` 均 import 自同一位置 ✓
- `buildGeneratedFromCatalog(catalog: Catalog)` 在 Task 2 定义且测试，返回 `ModelMeta[]` 与 `mergeModelMeta` 入参一致 ✓
- `WHITELIST_PROVIDERS` 13 项与 spec §5.1 逐字一致 ✓

**已识别的非阻塞风险**（执行时留意）：
- Task 3 实跑脚本依赖网络与 models.dev 实时数据，N 值与具体定价会随时间变动；抽样校验只验证单位正确性，不锁数值。
- generated 对 `qwen-max` 等"白名单覆盖但国内 API 实际限制可能不同"的模型会采用 models.dev 的 contextWindow；若执行者发现明显失真，可在 override 增补该 id 的 `contextWindow` 修正（无需改脚本）。
