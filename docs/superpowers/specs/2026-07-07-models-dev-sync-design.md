# models.dev 构建期同步：自动化模型元数据维护

- **日期**: 2026-07-07
- **状态**: 待实现（设计已批准）
- **关联**: `2026-06-13-custom-model-add-design.md`（ChannelModel 动态列表，与本设计分属两层，见 §6）

## 1. 背景与现状

模型静态元数据集中维护在 `packages/shared/src/data/model-meta.ts` 的 `MODEL_META_REGISTRY`（约 60 条），通过 `@lume/shared` 导出，被 `cli` / `sdk` / `apps/sidecar` 等消费。提供 `findModelMeta`（精确 + alias + 前缀模糊匹配）、`inferCapabilities`（启发式兜底）、`formatContextWindow`、`formatPricing`。有完整 `bun:test` 覆盖（`model-meta.test.ts`）。

字段：`id / aliases? / displayName / contextWindow / capabilities{vision,toolUse,reasoning} / pricing?{input,output} / description?`。

**痛点（手工维护）**：

1. **定价易过时**：厂商调价后本地不会自动跟进（如 `gpt-4o-mini` 等）。
2. **新模型上线滞后**：`claude-fable-5`、`gpt-5.2`、`glm-5.2`、`kimi-k2.7-code` 等已发布，本地 registry 缺失。
3. **能力标记靠人工判断**：`vision` / `reasoning` 易标错，且 `inferCapabilities` 的正则启发式（`/o1|o3|r1/`）本可被权威数据源替代。
4. **冗余条目**：`claude-sonnet-4` 与 `claude-sonnet-4-5`、`gpt-4.1` 系列等存在维护负担。

## 2. 目标 / 非目标

**目标**

- 引入构建期同步脚本，从 [models.dev](https://models.dev) 的 `catalog.json` 自动生成模型元数据，**人工 review diff 后 commit**。
- 自动更新 `contextWindow` / `capabilities` / `pricing` / `displayName`，并**自动发现白名单 provider 下的新模型**。
- 保留本地定制（中文 `description`、`aliases`、国产缺口模型、字段修正）不被脚本覆盖。
- **`model-meta.ts` 公开 API 与行为零变更**，现有消费方与测试无需改动。

**非目标（YAGNI）**

- 不做运行期拉取 / 缓存（构建期同步已满足）。
- 不改动 `model-meta.ts` 对外接口、不扩 `ModelMeta` 新字段（见 §7）。
- 不做 UI 改动。
- 不同步 logo（`/logos/*.svg`）——无消费方，后续单独做。
- 不做 CI 周更自动 PR——首期手动 `pnpm sync:models`，CI 留作后续。

## 3. 数据源

仅拉取一个端点：`https://models.dev/catalog.json`（约 3 MB）。

```jsonc
{
  "models":   { "anthropic/claude-sonnet-4-5": { /* provider-agnostic 元数据，无 cost */ }, ... },
  "providers": {
    "anthropic": {
      "id": "anthropic", "name": "Anthropic", "npm": "@anthropic-ai/sdk", ...,
      "models": {
        "claude-sonnet-4-5": {
          /* 完整元数据（同上） + 定价 */
          "name": "Claude Sonnet 4.5 (latest)",
          "description": "...",
          "attachment": true, "reasoning": true, "tool_call": true,
          "modalities": { "input": ["text","image","pdf"], "output": ["text"] },
          "limit": { "context": 200000, "output": 64000 },
          "cost": { "input": 3, "output": 15, "cache_read": 0.3, "cache_write": 3.75 }
        }
      }
    }
  }
}
```

**关键事实（已核实）**：

- `catalog.providers[p].models[m]` **同时含完整元数据 + `cost`** → 一个文件取齐，无需再拉 `models.json`。
- **`cost.input` / `cost.output` 单位为 USD / 1M tokens**，与本地 `ModelPricing` 一致，**无需换算**（实测 `claude-sonnet-4-5` = `$3/$15`，与本地精确吻合）。
- provider 端 model 的 key（`m`）即裸 id（`gpt-5.2`，无 `provider/` 前缀），与本地 `id` 体系一致。

## 4. 架构

```
┌─────────────────┐   fetch    ┌──────────────────────────┐
│  models.dev     │ ─────────► │ scripts/sync-models.ts   │  pnpm sync:models
│  catalog.json   │            │  · 白名单 provider 过滤    │
└─────────────────┘            │  · canonical 优先级去重    │
                               │  · 字段映射 + schema 校验   │
                               └────────────┬─────────────┘
                                            │ write（机器生成，可安全重写）
                                            ▼
                               ┌──────────────────────────┐
                               │ model-meta.generated.json │  ← review 看 diff
                               └────────────┬─────────────┘
                                            │
                  ┌──────────────────────────┐
                  │ model-meta.override.ts    │  ← 人工稳定层
                  │  · 中文 description        │
                  │  · aliases                │
                  │  · 国产缺口（doubao 等）   │
                  │  · 字段修正               │
                  └─────────────┬─────────────┘
                                │  merge（深合并，override 优先）
                                ▼
                  ┌──────────────────────────┐
                  │ model-meta.ts             │  ← 公开 API 不变
                  │  mergeModelMeta(generated,│     现有消费方 / 测试零改动
                  │              override)    │
                  │  buildLookupMap(merged)   │
                  └──────────────────────────┘
```

**新增 3 个文件 + 改造 1 个**：

| 文件 | 性质 | 说明 |
|---|---|---|
| `packages/shared/scripts/sync-models.ts` | 新增 | 同步脚本（可执行） |
| `packages/shared/src/data/model-meta.generated.json` | 新增（产物） | 机器生成，git tracked，稳定 key 顺序 |
| `packages/shared/src/data/model-meta.override.ts` | 新增（人工） | 稳定层，脚本永不写入 |
| `packages/shared/src/data/model-meta.ts` | 改造 | 新增纯函数 `mergeModelMeta(generated, override)`；`buildLookupMap` 基于 merge 结果构建；公开 API 不变 |

## 5. 字段映射与 provider 映射

### 5.1 白名单 provider（canonical 优先级，先到先得去重）

```
anthropic, openai, google, zhipuai, deepseek, alibaba,
moonshotai, stepfun, minimax, xai, mistral, cohere, meta
```

聚合器（`openrouter`、`together`、`fireworks` 等）**不进**白名单，避免其定价覆盖官方价。

脚本按上述顺序遍历各 provider 的 `models`，对每个 model id：**已收录则跳过，未收录则纳入**。因官方 provider 均排在聚合器前（且聚合器不在表内），同一模型的官方版本自然优先——无需显式去重逻辑。

### 5.2 字段映射

`catalog.providers[p].models[m]` → `ModelMeta`：

| 源 | 目标 | 说明 |
|---|---|---|
| `m`（key） | `id` | 裸 id |
| `name` | `displayName` | |
| `limit.context` | `contextWindow` | 缺失则跳过该模型并 warn |
| `attachment` \|\| `'image' ∈ modalities.input` | `capabilities.vision` | |
| `tool_call` | `capabilities.toolUse` | |
| `reasoning` | `capabilities.reasoning` | |
| `cost.input` / `cost.output` | `pricing.input` / `pricing.output` | 任一缺失则 `pricing` 省略 |
| `description` | `description` | 英文；override 覆盖为中文 |

**序列化稳定性**：generated.json 按 `id` 字典序输出，保证 diff 干净、review 友好。

## 6. merge 机制（generated + override）

### 6.1 override 文件结构

```ts
// model-meta.override.ts —— 人工稳定层，脚本永不写入
export interface ModelOverride {
  displayName?: string
  contextWindow?: number
  capabilities?: Partial<{ vision: boolean; toolUse: boolean; reasoning: boolean }>
  pricing?: { input: number; output: number }
  description?: string
  aliases?: string[]
}
export const MODEL_OVERRIDES: Record<string, ModelOverride> = {
  'claude-sonnet-4-5': {
    aliases: ['claude-3-5-sonnet', 'anthropic/claude-sonnet-4-5'], // 补旧别名 / 前缀
    description: '擅长代码和日常任务',                                  // 中文化
  },
  'doubao-pro-32k': {                                                  // 国产缺口（generated 无）
    displayName: 'Doubao Pro 32K',
    contextWindow: 32_000,
    capabilities: { vision: false, toolUse: true, reasoning: false },
  },
}
```

### 6.2 merge 规则

1. `generated` 条目为基础。
2. 同 id 的 override **深合并**覆盖 generated：标量字段直接覆盖；`capabilities` 按字段合并；`pricing` 整体替换；`aliases` **追加去重**（保留 generated 与 override 双方别名，不互相丢弃）。
3. override 中存在、generated 中不存在的 id（如 `doubao-*`、老 `glm-4-*`、`moonshot-v1-*`、`step-router-v1`）作为**新条目追加**。
4. `findModelMeta` / `inferCapabilities` / `formatContextWindow` / `formatPricing` 的签名与匹配行为**完全不变**。新增纯函数 `mergeModelMeta(generated, MODEL_OVERRIDES)` 返回最终 `ModelMeta[]`，`buildLookupMap` 改为基于其结果构建——现有 14 个测试用例零改动通过。`mergeModelMeta` 作为纯函数可独立单测。

> **merge 规则是本设计里唯一带业务取舍的代码**（override 何时覆盖、何时追加、alias 合并方向）。按 learning 模式，该函数留作带签名 + 注释的占位，交由实现者定具体语义。

### 6.3 首次迁移（seed override）

脚本首次运行前，需把现有 `MODEL_META_REGISTRY` 里的**中文 `description`** 与全部 **`aliases`** 提取到 `model-meta.override.ts` 作为初始内容（一次性人工/半自动完成），避免首次同步后中文描述丢失。`pricing` / `contextWindow` / `capabilities` 不进 override（交给 generated 维护）。

## 7. 与 ChannelModel 的关系（不冲突）

`2026-06-13-custom-model-add-design.md` 处理的是 `ChannelModel`（用户某渠道启用的动态模型列表，落盘 `channels.json`，依赖 `normalizeChannelModel` / `inferChannelModelCapabilities`）。本设计处理的是 `ModelMeta`（模型静态元数据）。两者分属不同层：

- 本设计**不触碰** `ChannelModel`、`channels.json`、`ChannelForm.tsx`。
- `ModelMeta` 数据更全后，对依赖 `findModelMeta` / `inferCapabilities` 的下游（含渠道侧能力推断）是**正向增强**，无破坏性。

## 8. 错误处理

- **网络失败 / 非 200 / 解析错误**：脚本以非零码退出，**不覆盖**现有 `model-meta.generated.json`，仓库保持上次可用状态。
- **schema 校验**：轻量手写 guard（不引入 zod）校验 `cost` / `limit` / `modalities` 结构；单字段不合法则跳过该字段并 `console.warn`，不中断整批。
- **canonical provider 缺失某模型**：该模型无 `pricing`，`pricing` 省略（与现状一致，不报错）。
- **白名单 provider 在 catalog 中不存在**：warn 并跳过，不报错。

## 9. 测试（bun:test，对齐现有模式）

**`scripts/sync-models.test.ts`**（内联 mini catalog fixture）：

- 字段映射正确（`limit.context → contextWindow`、`attachment → vision`、`cost → pricing`）。
- 白名单过滤生效（聚合器模型不收录）。
- canonical 优先级去重（官方版本优先）。
- 定价单位未被误转（断言 `claude-sonnet-4-5` 为 `$3/$15` 而非 `$0.000003`）。
- 网络失败时不覆盖现有 generated.json。
- 幂等性：连续运行两次，第二次 generated.json 无 diff。

**`model-meta.test.ts`**（现有 11 个用例保持通过 + 新增）：

- override 覆盖 generated（标量 / `capabilities` 分量 / `pricing` 整体）。
- override 追加 generated 不存在的新模型。
- `aliases` 合并去重。
- 现有模糊匹配、大小写、前缀匹配行为不变。

## 10. 验证标准

- [ ] `pnpm sync:models` 能成功生成 `model-meta.generated.json`，含 13 个白名单 provider 的模型。
- [ ] 生成数据定价单位正确（抽样 `claude-sonnet-4-5` = `$3/$15`、`gpt-5.2` = `$1.75/$14`、`glm-5.2` = `$1.4/$4.4`）。
- [ ] 新模型（`claude-fable-5` / `gpt-5.2` / `glm-5.2`）出现在生成结果中。
- [ ] override 中的中文 `description` / `aliases` / 国产缺口模型在最终 registry 中保留。
- [ ] 现有 `model-meta.test.ts` 11 个用例全部通过（回归护栏）。
- [ ] 脚本幂等：连续两次运行 `git diff` 为空。
- [ ] 网络中断时脚本退出码 ≠ 0 且未污染 generated.json。
- [ ] `@lume/shared` 构建产物正常，下游消费方无类型错误。

## 11. 非目标汇总（YAGNI）

| 不做 | 理由 |
|---|---|
| 运行期拉取 / 缓存 | 构建期同步已满足离线 + 时效 |
| 扩 `ModelMeta` 新字段（`maxOutputTokens` / `cache_read` / `reasoning_options`） | 暂无消费方，避免投机性扩展 |
| logo 同步 | 无消费方 |
| CI 自动 PR | 首期手动触发 |
| 全量同步 / openrouter 口径 / 多 provider 多价 | 已被定价与范围决策排除 |
| 改动 `ChannelModel` / UI / IPC | 分属不同层，见 §7 |
