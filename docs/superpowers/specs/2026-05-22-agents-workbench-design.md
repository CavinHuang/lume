# Agents 团队工作台设计

> 日期: 2026-05-22
> 状态: 设计方向已确认，等待 spec review 与用户复核
> 范围: 设置页 Agents 管理界面、内置角色注册表、运行时角色接入、关键词推荐与并发规则

## 概述

为 Lume 增加一个设置内的 Agents 团队工作台。第一版采用“共享角色注册表驱动 UI 与运行时”的方案：用一份内置 Agent Role registry 复刻 Alice 的 11 个专业角色，并让设置页、子代理运行时、关键词推荐和并发判断都从同一份定义派生。

用户已确认第一版选择方案 2：不是纯展示页，也不做完整可编辑角色管理器。第一版角色以“内置、只读配置”为主，但要为后续方案 3 演进预留数据结构与界面入口。

## 背景

Alice 的内置 Agent 角色系统包含 11 个角色，每个角色有：

- 稳定 id
- 英文名与中文名
- 职能描述
- system prompt
- 默认 Skill 名称
- 默认后台运行设置
- 只读/可写并发策略
- 输出类型
- 关键词推荐规则

Lume 当前已有可以复用的基础：

- Settings 页面与侧边 tab 结构
- `buildBuiltinAgents()` 内置 SubAgent 定义
- workspace 自定义 agent markdown loader
- SDK `Agent` 工具可按 `subagent_type` 启动子代理
- Subagent run 记录中已有 `requestedAgentId` / `resolvedAgentId`
- Skills 与 workspace capability 已有基本管理能力

第一版应把 Alice 的角色模型转成 Lume 原生结构，而不是把 Alice 代码形态直接搬进 UI。

## 目标

- 在设置页新增 `Agents` 入口。
- 复刻 Alice 的 11 个内置角色：researcher、translator、writer、voice、designer、artist、analyst、quant、novelist、docsmith、developer。
- 每个角色展示中文名、英文名、职能、IP 图、默认 Skill、输出类型、后台运行、只读/可写状态。
- 内置角色可被 Lume runtime 作为 `Agent` 工具的 `subagent_type` 使用。
- 实现关键词推荐纯函数：输入用户文本，返回按命中分数排序的推荐角色。
- 实现并发判断纯函数：基于 `canParallelWith` 判断两个角色是否可以并行。
- 让 UI 和 runtime 共用同一份角色定义，避免双份维护。
- 为后续“可编辑角色管理器”保留模型边界和 UI 入口。

## 非目标

- 第一版不允许用户编辑内置角色 prompt。
- 第一版不支持从 UI 新建自定义 agent。
- 第一版不支持上传或替换 IP 图。
- 第一版不做自动任务拆分编排器。
- 第一版不强制把推荐角色自动插入用户消息。
- 第一版不重构现有 Skill 市场或 MCP 设置。
- 第一版不新增依赖。

## 产品形态

### 设置导航

Settings 增加 `Agents` tab，建议放在 `模型` 之后、`工作区` 之前。

原因：

- Agents 依赖模型和运行时，但不是模型供应商设置。
- 比 Skills/MCP 更接近“谁来做事”的用户心智。
- 后续如果有团队编排，也应优先出现在设置主导航中。

### 页面布局

采用用户确认的方案 B：角色卡片目录 + 详情抽屉。

页面结构：

- 顶部概览：内置角色数量、只读角色数量、后台角色数量、可写角色数量。
- 搜索与过滤：按角色名称、职能、skill、关键词过滤。
- 角色卡片网格：每张卡展示 IP 图、中文名、英文名、职能、标签。
- 详情抽屉：点击角色后打开，展示更完整的角色定义。

卡片展示：

- IP 图
- 中文名
- 英文名
- 角色 id
- 一句话职能
- `只读` / `可写`
- `后台运行` 标签
- 默认 Skill 名称

详情抽屉展示：

- 角色完整描述
- system prompt 摘要或只读预览
- 默认 Skill 名称
- 输出类型
- 推荐关键词
- 可并行角色列表
- 冲突角色列表
- 运行时 id 与状态

第一版不提供编辑控件，但可以保留“复制为自定义角色”禁用态或 future note，避免用户误以为内置角色不可扩展。

## 角色注册表

新增逻辑模型 `AgentRoleDefinition`。建议放在 shared 层，或放在 shared 可导出文件中并由 sidecar/web 共用。

建议字段：

```ts
interface AgentRoleDefinition {
  id: AgentRoleId
  name: string
  displayName: string
  title: string
  description: string
  avatarAsset: string
  defaultSkillName: string
  defaultBackground: boolean
  concurrency: {
    defaultReadOnly: boolean
    outputTypes: string[]
    canParallelWith: "*" | AgentRoleId[]
  }
  keywords: string[]
  systemPrompt: string
}
```

设计约束：

- `id` 是稳定运行时协议，不随展示名变化。
- `avatarAsset` 使用项目内置资源路径或可被前端静态导入的 key。
- `keywords` 直接进入推荐函数，不嵌在 UI。
- `concurrency` 进入并发纯函数，不嵌在组件判断里。
- `systemPrompt` 进入 runtime，不由 UI 拼接。

## 运行时接入

`buildBuiltinAgents()` 应从角色注册表派生 Alice 风格的内置 agent 定义。

映射规则：

- `description` 来自角色描述。
- `prompt` 来自 `systemPrompt`，必要时追加 Lume 子代理通用约束。
- `model` 使用 `inherit`。
- 只读角色优先使用只读工具集合。
- 可写角色使用当前默认子代理工具策略，继续受 Lume 权限系统约束。
- `defaultSkillName` 不强制自动调用 Skill，但会写入 prompt 或 manifest 提示，让角色知道首选能力。

只读策略：

- `researcher`、`translator`、`quant` 默认为只读、后台运行、可与所有角色并行。
- 只读角色不应获得写文件工具，除非后续显式覆盖。
- 只读角色仍可使用搜索、读取、分析类能力。

可写策略：

- `writer`、`voice`、`designer`、`artist`、`analyst`、`novelist`、`docsmith`、`developer` 保持可写定义。
- 可写能力仍由 Lume 权限模式和工具策略决定，角色定义不能绕过权限系统。

## 推荐规则

实现 `suggestAgentRoles(input: string): AgentRoleSuggestion[]`。

规则与 Alice 保持相同心智：

1. 输入转小写。
2. 每个角色用关键词数组计分。
3. 命中分数为 0 的角色过滤掉。
4. 按分数降序。
5. 分数相同按注册表顺序稳定排序。

返回结构建议：

```ts
interface AgentRoleSuggestion {
  roleId: AgentRoleId
  score: number
  matchedKeywords: string[]
}
```

第一版 UI 使用方式：

- 在 Agents 设置页可输入一句任务，预览推荐角色。
- 不在主聊天输入框强行接入推荐。

后续可扩展：

- 主输入框 `@` 菜单推荐。
- 任务拆分时推荐可并行角色。
- 自动团队编排前展示推荐理由。

## 并发规则

实现 `canAgentRolesRunInParallel(roleA, roleB): boolean`。

判定规则：

1. 任一角色 `canParallelWith` 为 `"*"`，可并行。
2. A 的白名单包含 B，可并行。
3. B 的白名单包含 A，可并行。
4. 其他情况不可并行。

UI 使用方式：

- 详情抽屉显示“可并行”和“冲突”角色。
- 后续团队编排器可以复用同一函数。

第一版不做复杂锁调度，只提供规则与展示。

## IP 图资产

已通过 image generation 为 11 个角色和一张团队群像生成预览图。实现阶段应把最终选中的图复制进项目，例如：

```text
apps/web/src/assets/agents/
  researcher.png
  translator.png
  writer.png
  voice.png
  designer.png
  artist.png
  analyst.png
  quant.png
  novelist.png
  docsmith.png
  developer.png
  agents-team.png
```

源图当前位于：

```text
/Users/cavinhuang/.codex/generated_images/019e4d20-3736-7242-bc86-312ef120bc1a
```

要求：

- 复制源图，不移动或删除原图。
- 项目内文件名使用角色 id。
- UI 引用项目内资源，不引用 `.codex/generated_images`。
- 第一版不做透明背景处理，卡片用统一裁切与背景容器保证一致。

## 方案 3 演进计划

第一版的模型要为完整可编辑角色管理器保留空间，但不提前实现。

后续方案 3 可分阶段推进：

### 3.1 复制为自定义角色

用户可以从内置角色复制一份到 workspace 自定义 agents。

需要：

- 自定义角色 id 命名规则。
- 继承内置角色字段作为初始值。
- 与现有 markdown loader 或新 JSON/YAML 存储兼容。
- UI 明确区分 `内置` 与 `自定义`。

### 3.2 编辑角色配置

允许编辑：

- display name
- description
- system prompt
- keywords
- default skill
- read-only/background 默认值
- output types
- canParallelWith

需要版本化或撤销策略，避免用户破坏内置角色后无法恢复。

### 3.3 替换 IP 图

允许上传图片或选择生成图。

需要：

- workspace asset 存储位置。
- 图片尺寸与裁切规则。
- 回退图策略。
- 不把用户图混入内置 assets。

### 3.4 团队编排

基于推荐和并发规则，提供任务拆分/角色选择面板。

需要：

- 推荐角色解释。
- 并发冲突提示。
- 用户确认后再启动多 agent。
- 与权限、工作区隔离、subagent run 观测打通。

## 数据边界

内置角色注册表是产品定义，不是用户数据。

用户未来自定义角色应进入 workspace 或全局用户配置，而不是改写内置 registry。

建议边界：

- 内置 registry：版本随 app 发布。
- workspace custom agents：项目级团队角色。
- global custom agents：用户跨工作区角色，后续再做。

## 错误处理

- 角色 id 不存在：runtime 回退到现有通用子代理，UI 显示未知角色。
- IP 图缺失：卡片显示基于 displayName 首字母或 role icon 的 fallback。
- Skill 不存在：详情抽屉提示未安装/未发现，但角色仍可运行。
- system prompt 为空：构建时测试失败，不允许发布。
- keywords 为空：推荐函数不推荐该角色，但 UI 仍展示。
- 并发配置引用未知角色：测试失败。

## 验证

需要覆盖的可测试逻辑：

- registry 包含 11 个内置角色且 id 唯一。
- 每个角色包含必需字段。
- `suggestAgentRoles` 能按关键词命中和分数排序。
- `canAgentRolesRunInParallel` 覆盖 `"*"`、单向白名单、双向白名单和冲突场景。
- runtime 内置 agent 定义从 registry 派生，并保留 prompt/description/model。
- 只读角色不会派生出写工具策略。

UI 可测试点：

- Settings nav 出现 `Agents`。
- Agents 页面渲染 11 张角色卡。
- 搜索/过滤能找到中文名、英文名、role id、关键词。
- 点击卡片显示详情抽屉。

样式、文案和纯视觉微调不需要跑全量 lint/typecheck。只在改动共享逻辑、runtime 映射或组件行为时跑相关测试。

## 实施顺序

1. 增加 shared agent role 类型、registry、推荐函数、并发函数和测试。
2. 复制 IP 图到 `apps/web/src/assets/agents/`，建立角色 id 到 asset 的映射。
3. 调整 sidecar `buildBuiltinAgents()`，从 registry 派生运行时内置角色。
4. 新增 Settings `Agents` tab 和 `AgentsSettings` 页面。
5. 实现角色卡片目录、搜索/过滤和详情抽屉。
6. 在设置页加入任务文本推荐预览。
7. 补齐相关单测或组件测试。

## 开放问题

- 内置角色的完整 system prompt 是否要完全复刻 Alice 原文，还是先采用 Lume 化摘要 prompt？
- `defaultSkillName` 第一版是否只展示，还是在 prompt 中显式要求优先调用对应 Skill？
- 只读角色的工具白名单应在 SDK 层定义，还是在 sidecar runtime 派生时过滤？
- IP 图是否需要人工筛选后再进入项目，还是直接使用本轮生成的 11 张图？
