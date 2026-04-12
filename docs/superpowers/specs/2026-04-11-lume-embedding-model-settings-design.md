# Lume Embedding 模型设置设计

- 日期: 2026-04-11
- 主题: 在模型与供应商设置中增加 embedding 模型设置，并纳入统一系统设置模块
- 状态: 已确认，待进入 implementation plan

## 1. 目标

Lume 需要为记忆向量化能力提供一个正式的 embedding 模型设置入口。

这个设置必须满足：

1. 用户可以在“模型与供应商”页中配置
2. 主真相源不是 `lume.yaml`，而是系统设置模块
3. `lume.yaml` 只作为系统设置 override
4. 所有系统读取 embedding 设置时都走统一的系统设置模块
5. 模型表达统一为 `provider/model`

## 2. 核心设计原则

### 2.1 系统设置模块是唯一读取入口

后续系统任何地方都不应各自直接读取：

1. settings 主配置
2. `lume.yaml`
3. 环境变量

正确方式是：

1. 统一通过系统设置模块读取
2. 系统设置模块内部负责合并配置来源
3. 对外只暴露当前有效配置

### 2.2 `lume.yaml` 只是 override，不是主配置源

embedding 设置的主存储应在系统设置模块的主配置中。

`lume.yaml` 如果提供对应字段，只在运行时覆盖主配置值。

### 2.3 模型表达统一使用 `provider/model`

embedding 模型设置不再拆成：

1. provider
2. model

而统一存为：

```ts
memory.embedding.defaultModelRef = "openai/text-embedding-3-small"
```

这与其它模型设置保持一致，也便于统一解析。

## 3. 配置模型

### 3.1 系统设置模块中的字段

建议在系统设置模块中新增：

```ts
systemConfig.memory.embedding.defaultModelRef?: string
```

运行时有效配置为：

```ts
effectiveSystemConfig.memory.embedding.defaultModelRef?: string
```

### 3.2 `lume.yaml` override 字段

`lume.yaml` 可以提供对应覆盖：

```yaml
memory:
  embedding:
    defaultModelRef: "openai/text-embedding-3-small"
```

它只影响 runtime effective config，不改变主配置存储。

## 4. 读取优先级

系统设置模块内部应按以下优先级解析 embedding 模型：

1. `lume.yaml` override
2. 系统设置主配置
3. 环境变量 fallback
4. 内置默认值

对外部调用方来说，不需要关心优先级，只读取最终 effective config。

## 5. UI 入口设计

### 5.1 主入口位置

主入口放在“模型与供应商”设置页。

原因：

1. 用户天然会去这里找模型相关配置
2. embedding 模型本质上仍是模型供应商体系的一部分

### 5.2 展示形式

在“模型与供应商”页新增一个独立设置块：

- 默认 Embedding 模型

展示上可以分两步引导用户选择，但最终落盘必须收敛成一个 `provider/model` ref。

示例 UI：

1. provider 选择器
2. provider 下的 embedding model 选择器
3. 最终保存为 `defaultModelRef`

### 5.3 辅助说明

设置页应明确说明该设置影响：

1. 记忆向量化
2. 记忆检索质量
3. 记忆索引成本
4. 未来其它非对话 embedding 能力

## 6. 渠道与 provider 的关系

embedding 设置不以 channel 为主键。

原因：

1. 你已经明确要求所有模型设置遵循 `provider/model`
2. embedding 设置属于系统能力设置，而不是某个单独 channel 的局部设置
3. channel 只是 UI 里帮助用户理解 provider 的入口，不应该成为最终配置表达

## 7. 与现有 embedding 实现的关系

当前 `embedding.ts` 里主要还是依赖：

1. `LUME_MEMORY_PROVIDER`
2. `LUME_MEMORY_OPENAI_MODEL`
3. `LUME_MEMORY_GEMINI_MODEL`
4. `OPENAI_API_KEY`
5. `GEMINI_API_KEY`

新的目标是：

1. 优先从系统设置模块拿 `memory.embedding.defaultModelRef`
2. 再由系统设置模块解析 provider/model
3. 环境变量仅作为 fallback

也就是说：

- 环境变量不再是主行为来源
- 主行为来源是 effective system config

## 8. 为什么不直接把设置放进 `lume.yaml`

因为 `lume.yaml` 在 Lume 中的职责已经明确为：

1. 覆盖系统设置
2. 不是设置系统的主存储

如果 embedding 模型直接主存到 `lume.yaml`，会破坏这个边界。

## 9. 为什么不继续拆成 provider + model

因为你已经明确要求：

1. 所有模型设置都要统一遵循 `provider/model`

继续拆字段会导致：

1. 模型设置结构不一致
2. 解析逻辑分裂
3. override 合并更复杂

## 10. V1 最小落地范围

V1 需要完成：

1. 系统设置模块增加 `memory.embedding.defaultModelRef`
2. `lume.yaml` 支持 override 同路径字段
3. embedding provider 解析优先读 effective system config
4. 模型与供应商页增加 embedding 设置区块

V1 不要求：

1. workspace 级 embedding override
2. 每个 provider 独立保存多套 embedding 设置
3. 为 embedding 单独增加第二套凭证体系

## 11. 预期收益

完成后会得到：

1. embedding 模型设置有正式 UI 入口
2. 设置主存储和 override 边界清晰
3. 所有系统从统一模块拿配置
4. 模型表达统一，后续可持续扩展

