# Model Action Settings Design

## Goal

在模型设置页增加两个顶层 Tab：

- `模型供应商`：保留当前供应商、API Key、启停、默认模型入口。
- `模型设置`：按动作选择模型，让用户能明确控制当前已有运行时入口的模型。

本次只做真实可生效的动作设置，不做假入口。

## Scope

本次接入这些动作：

- 默认对话/Agent：复用 `models.agent`。
- 子 Agent：复用 `models.subagent.defaultModelRef`。
- 日程调度：新增独立配置，未设置时回退到 Agent 默认模型。
- 记忆提取：复用 `memory.extraction.modelRef`。
- 记忆 rerank：复用现有 runtime memory config 的 `retrieval.rerankModelRef`。
- Embedding：复用 `models.embedding.defaultModelRef`。

本次不接入：

- 标题生成
- 欢迎建议
- 权限分类
- 记忆预判
- 图像生成模型优先级
- 模型上下文长度编辑

这些项目前没有统一、清晰的运行时配置入口；等调用点明确后再加。

## UI

`AgentSettings` 顶部增加 Tab 状态：

- `模型供应商` 显示现有统计卡、默认模型卡、供应商配置卡。
- `模型设置` 显示分组设置卡：
  - 主力模型：默认对话/Agent、子 Agent、日程调度。
  - 记忆模型：记忆提取、记忆 rerank、Embedding。

每行使用同一套模型下拉：

- 默认对话/Agent 必选具体模型。
- 其他动作允许“与默认对话模型相同”或选择具体模型。
- Embedding 继续使用可用 embedding 模型入口；如果现有工具只暴露当前 embedding 设置，先复用当前选择 UI，不新增模型发现逻辑。

## Config

复用已有配置路径优先：

- `models.agent`
- `models.subagent`
- `models.embedding.defaultModelRef`
- `memory.extraction.modelRef`
- `memory.retrieval.rerankModelRef`

新增一个最小路径用于日程调度：

- `models.routine.defaultModelRef`

`models.routine.defaultModelRef` 为空时，运行时回退到 `models.agent.defaultModelRef`，再按现有逻辑回退。

## Runtime

只改已有明确读取点：

- 日程调度读取 `models.routine.defaultModelRef`，没有则沿用 Agent 默认模型。
- 子 Agent、记忆提取、rerank、Embedding 保持现有读取路径。

不新增标题、欢迎建议、权限分类、图像生成等调用点的模型选择逻辑。

## Error Handling

- 保存失败时 toast 错误并保留当前 UI 值。
- 模型列表为空时显示禁用选择器。
- 配置里指向不存在模型时显示原始 model ref，用户可重新选择。

## Testing

最小验证：

- 配置 schema 接受 `models.routine.defaultModelRef`。
- 日程调度选择模型时优先使用 routine 配置，未设置时回退 Agent。
- UI helper 覆盖继承/显式选择 payload。

纯布局 Tab 不做重型测试。

## Self Review

- No placeholders.
- Scope is intentionally limited to settings that can affect runtime today.
- Runtime fallback is explicit.
- Skipped screenshot items are listed so they are not accidentally presented as working settings.
