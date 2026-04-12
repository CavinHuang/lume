# Lume 设置中心存储重设计

- 日期: 2026-04-11
- 主题: 重新设计 Lume 的系统设置中心与主配置存储方式
- 状态: 已确认，待进入 implementation plan

## 1. 目标

Lume 当前的系统设置是分散存储的：

1. `settings.json`
2. `channels.json`
3. `system-prompts.json`
4. `chat-tools.json`
5. `memory/config.json`
6. agent runtime config
7. automation jobs
8. `lume.yaml` override

这种结构的问题不是“文件太多”，而是：

1. 没有统一真相源
2. 每个模块都可能绕过系统设置中心自行读取
3. `lume.yaml` 和主配置边界不清楚
4. 新配置项很难判断该落到哪里

新的设置中心需要满足：

1. 单一主配置文件
2. `lume.yaml` 只作为 override
3. 所有系统设置统一从一个模块读取
4. UI state 不混入系统设置
5. 所有模型设置统一遵循 `provider/model`

## 2. 核心设计原则

### 2.1 单一主配置文件

Lume 的系统设置主真相源统一为：

- `~/.lume/lume.json`

它是所有系统设置的 primary source。

### 2.2 `lume.yaml` 只是 override

`~/.lume/lume.yaml` 保留，但只承担 override 职责。

它不是：

1. 主配置文件
2. 设置页直接写入的目标
3. 系统设置的唯一来源

### 2.3 系统设置模块是唯一读取入口

后续系统中的任何模块都不应直接读取：

1. `lume.json`
2. `lume.yaml`
3. 旧配置文件
4. 环境变量

正确做法是：

1. 统一调用系统设置模块
2. 由系统设置模块输出 `effective system config`

### 2.4 UI state 与系统设置彻底分离

系统设置文件不承载：

1. 当前选中项
2. 会话草稿
3. 面板开关
4. 窗口状态

这些继续留在 UI state 专用存储中。

## 3. 主配置文件

### 3.1 文件路径

- 主配置：`~/.lume/lume.json`
- 覆盖文件：`~/.lume/lume.yaml`

### 3.2 顶层结构

采用：

```json
{
  "version": 1,
  "models": { ... },
  "memory": { ... },
  "agent": { ... },
  "automation": { ... },
  "prompts": { ... },
  "tools": { ... }
}
```

## 4. Section 边界

### 4.1 `models`

职责：

1. provider / channel 目录
2. chat / agent 默认模型
3. embedding 默认模型

embedding 模型表达统一为：

```ts
models.embedding.defaultModelRef = "openai/text-embedding-3-small"
```

### 4.2 `memory`

职责：

1. 记忆系统行为设置
2. recall policy
3. distillation policy
4. memory runtime defaults

### 4.3 `agent`

职责：

1. agent 默认运行偏好
2. permission mode
3. thinking level
4. tool policy 默认值

### 4.4 `automation`

职责：

1. 自动化任务定义
2. 自动化系统动作配置
3. 调度策略

### 4.5 `prompts`

职责：

1. system prompt 配置
2. 默认 prompt 选择
3. prompt 行为设置

### 4.6 `tools`

职责：

1. chat tools 配置
2. 工具可用性设置
3. 工具相关系统策略

## 5. embedding 设置设计

### 5.1 主存储位置

embedding 设置属于系统设置模块中的正式配置项，而不是 `lume.yaml` 主存储项。

推荐字段：

```ts
models.embedding.defaultModelRef
```

### 5.2 模型表达

所有模型设置统一使用：

```ts
provider/model
```

embedding 也一样。

例如：

```ts
"openai/text-embedding-3-small"
"google/gemini-embedding-001"
```

### 5.3 UI 入口

主入口放在“模型与供应商”页。

可以通过 provider / model 两步选择帮助用户理解，但最终落盘必须收敛成：

```ts
defaultModelRef
```

### 5.4 读取顺序

embedding 模型运行时读取顺序：

1. `lume.json`
2. `lume.yaml` override
3. 环境变量 fallback
4. 内置默认值

但对调用方来说，永远只看到最终 effective value。

## 6. 系统设置模块输出

系统设置模块的核心输出应为：

```ts
effectiveSystemConfig
```

例如：

```ts
effectiveSystemConfig.models.embedding.defaultModelRef
effectiveSystemConfig.memory.distillation
effectiveSystemConfig.agent.permissionMode
```

调用方不关心这些值来自：

1. `lume.json`
2. `lume.yaml`
3. fallback

## 7. 与旧配置文件的迁移关系

目标迁移关系：

### 7.1 并入 `lume.json`

- `channels.json` -> `lume.json > models`
- `system-prompts.json` -> `lume.json > prompts`
- `chat-tools.json` -> `lume.json > tools`
- `memory/config.json` -> `lume.json > memory`
- agent runtime config -> `lume.json > agent`
- automation jobs -> `lume.json > automation`

### 7.2 不并入 `lume.json`

- `settings.json > uiState`

它保留为 UI state 专用文件。

## 8. 迁移顺序

正确迁移顺序：

1. 建立系统设置模块
2. 建立 `lume.json`
3. 统一读取改走系统设置模块
4. 将旧配置文件迁移进 `lume.json`
5. 写入入口切到系统设置模块
6. 旧配置文件退役

## 9. 最终状态要求

最终必须满足：

1. 系统设置只有一个 primary source：`lume.json`
2. `lume.yaml` 只负责 override
3. 旧分散配置文件不再驱动主行为
4. 所有模块统一从系统设置模块读取 effective config
5. UI state 与系统设置彻底分离

## 10. V1 最小落地范围

V1 需要完成：

1. 建立系统设置模块
2. 建立 `lume.json`
3. 把 embedding 设置接入系统设置模块
4. 在模型与供应商页提供 embedding 设置入口
5. `lume.yaml` 可覆盖该设置

V1 不要求：

1. 一次性把所有旧配置文件彻底迁完
2. 一次性重写所有设置页
3. workspace 级 embedding override

## 11. 预期收益

完成后会得到：

1. 设置中心终于有统一真相源
2. 新配置项有明确落点
3. embedding 设置有正式主配置路径
4. `lume.yaml` 与主配置边界清晰
5. 后续系统级设置迁移会更容易

