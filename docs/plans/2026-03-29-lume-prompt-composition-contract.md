# Lume Prompt Composition Contract

最后更新：2026-03-29

## 1. 目的

定义 Lume Agent 当前与后续版本的 prompt 组合契约，明确：

1. prompt 由哪些层组成
2. 各层职责边界
3. 线性展开顺序
4. 哪些层允许覆盖，哪些层只能追加
5. 当前代码入口与后续补齐项

这份文档解决的问题不是“文案怎么写”，而是“运行时到底按什么结构把 prompt 组出来”。

## 2. 设计原则

1. **Kernel 稳定**：执行协议、安全边界、基础 agent 行为必须稳定，不跟随 persona 随意漂移。
2. **Persona 可插拔**：人格、语气、关系风格、视觉设定属于 workspace identity，不应硬编码为所有 agent 的统一人格。
3. **Context 显式注入**：长期上下文与当前运行时上下文都必须以显式层注入，而不是混进单段模糊描述。
4. **能力路由可审计**：skills、memory、browser、search 等能力使用规则必须可以在 prompt 层被看见，也要能在代码层找到对应入口。
5. **模式追加而非污染内核**：dev/automation/output DSL 等规则优先作为 mode append 注入，不污染所有会话共享内核。

## 3. 六层模型

### 3.1 Layer 1: Base Kernel

定义所有 Agent 会话共享的稳定内核。

职责：

1. agent 身份主句
2. 执行协议
3. 主动汇报与承诺即行动
4. plan mode 规则
5. 委派策略
6. safety / persona truth guardrails
7. session bootstrap 读取顺序

当前入口：

1. `apps/sidecar/src/services/agent/agent-prompt-builder.ts`

当前输出：

1. `LUME_AGENT_IDENTITY_LINE`
2. `Agentic Execution`
3. `Commitment Enforcement`
4. `Proactive Updates`
5. `Delegation Policy`
6. `Plan Mode Protocol`
7. `Safety`
8. `Persona and Reality Guardrails`
9. `Session Bootstrap`

规则：

1. 只能由 runtime/kernel 代码维护
2. workspace persona 文件不能覆盖此层的安全与真实性约束
3. mode append 可在其后追加，但不应整体替换

### 3.2 Layer 2: Mode Kernel Append

定义只在特定执行模式下注入的 kernel 级附加规则。

职责：

1. automation non-interactive mode
2. minimal/full/none prompt mode 选择
3. dev gateway persona 切换
4. 未来的 task preset / run mode append

当前入口：

1. `apps/sidecar/src/services/agent/agent-prompt-builder.ts`
2. `templates/workspace/SOUL.dev.md`
3. `templates/workspace/IDENTITY.dev.md`

规则：

1. 属于 kernel 邻接层
2. 可以改变本轮 prompt 内容，但不能破坏 Base Kernel 的安全与真实性边界

### 3.3 Layer 3: Capability Policy Layer

定义能力路由和工具使用偏好。

职责：

1. Tooling 列表与命名
2. skill 调用规则
3. memory recall / memory write policy
4. browser-first policy
5. 未来的 skills-first / fallback order

当前入口：

1. `apps/sidecar/src/services/agent/agent-prompt-builder.ts`
2. `apps/sidecar/src/services/agent/capability-routing.ts`
3. `apps/sidecar/src/services/memory/memory-policy.ts`
4. `apps/sidecar/src/services/pi-agent/runtime-core/pi-tools.ts`

当前状态：

1. memory/browser/skill 前缀规则已存在
2. prompt 层已声明 `Skills-First Capability Routing`
3. prompt 层已声明 `Capability Routing Order`
4. 已存在轻量 capability routing helper，用于推导 lanes 与 preferred route
5. 仍未形成完整的 `skills-first -> search/install skill -> fallback` 代码级执行宪法

规则：

1. 这层允许按工具能力扩展
2. 不应把纯 persona 文案混入此层

### 3.3.1 当前能力优先级顺序

当前 prompt contract 约定的能力优先级为：

1. 已加载且明显匹配请求的 Skill
2. 专用一等工具：
   - `browser`：浏览器连续性、当前页面操作、profile/session 延续
   - `memory_search` / `memory_get`：历史决策、偏好、长期连续性
   - `web_search` / `web_fetch`：公共网页检索与抓取
3. 原始低层工具组合（read/write/edit/bash/find/grep/ls 等）
4. 若用户明确要求低层控制，则可跳过高层封装能力

### 3.3.2 Prompt-Level 与 Code-Level 的边界

当前状态需要明确区分：

#### Prompt-Level 已生效

以下规则已经进入 prompt 组合：

1. `Skills-First Capability Routing`
2. `Capability Routing Order`
3. `Browser-First Tool Policy`
4. `Memory Recall`
5. workspace dynamic context 中的 `Loaded Skills`

这意味着模型在运行时已经能“看到”这些规则。

#### Code-Level 已部分生效

以下约束已经由代码协助，但尚未形成完整路由执行器：

1. memory 工具有独立 runtime policy 与 tool allow/deny 机制
2. browser/memory/web_search 等工具已被单独建模为一等能力
3. workspace skills 已在 runtime context 中显式列出
4. 当 workspace 存在 skills 时，runtime `availableTools` 会显式包含 `Skill`
5. 已存在 `agent-runtime-context` + `capability-routing` helper，可生成 runtime routing trace
6. runtime prompt 组装阶段会输出结构化日志，记录 capability lanes、preferred route 与 routing reason
7. routing trace 会写入用户消息 metadata，并在当前 session UI header/message 中可见
8. 对 `browser / memory / web` 等高层路线，当前会生成保守的 soft tool policy，借助现有 `messageMetadata.toolPolicy` 收窄明显冲突的能力路径
9. UI 会显式展示 `soft policy active`，避免用户只看到 route 而不知道当前轮存在轻量收窄策略

#### Code-Level 尚未完全生效

以下内容仍主要依赖 prompt 引导，而非强执行路由：

1. “若已有匹配 Skill，则优先走 Skill” 还没有统一的 runtime dispatcher 强制执行
2. “无匹配 Skill 时先 search/discover capability 再 fallback” 还没有被代码级工作流统一接管
3. mode-specific capability append 仍未统一抽象
4. 当前 enforcement 仍是 soft policy，不是 hard routing gate

结论：

1. 当前 Capability Policy Layer 已完成 prompt-level contract
2. 但尚未完成 full code-level enforcement contract
3. 后续工作应在不破坏 prompt contract 的前提下，逐步把关键路由变成 runtime enforcement

### 3.4 Layer 4: Workspace Persona Layer

定义当前 workspace 中 agent 是谁、怎么说话、想成为什么样的存在。

职责：

1. 主体感
2. 关系风格
3. 会话语气
4. 工作风格
5. 外貌与视觉 identity
6. 自我识别规则

当前入口：

1. `templates/workspace/SOUL.md`
2. `templates/workspace/IDENTITY.md`
3. `templates/workspace/SOUL.dev.md`
4. `templates/workspace/IDENTITY.dev.md`

规则：

1. 强人格允许存在
2. 不得在此层编码 fake legal identity、fake credentials、fake real-world events
3. 此层的作用是增强关系感与一致性，不得覆盖 Base Kernel 中的 safety / truth guardrails

### 3.5 Layer 5: Workspace Operational Context Layer

定义 workspace 的长期上下文和用户可编辑规则。

职责：

1. `AGENTS.md`
2. `TOOLS.md`
3. `USER.md`
4. `IDENTITY.md`
5. `SOUL.md`
6. `MEMORY.md` / `memory.md`
7. `memory/YYYY-MM-DD.md`
8. `HEARTBEAT.md`

当前入口：

1. `apps/sidecar/src/services/system/workspace-bootstrap-service.ts`
2. `apps/sidecar/src/services/agent/agent-prompt-builder.ts`

当前表现：

1. 以 `Project Context` 段落线性注入
2. `SOUL.md` 存在时，builder 会显式提示 follow persona/tone
3. subagent 仅保留白名单文件注入

规则：

1. 这层是“工作区真相”，不是执行协议
2. 允许用户编辑
3. 不能破坏高优先级 Kernel 规则

### 3.6 Layer 6: Runtime Dynamic Context Layer

定义当前运行实例的即时上下文。

职责：

1. 当前时间
2. 当前 session 信息（sessionId / title / sessionType / chatType / parentSessionId / workspaceId / channelId / modelId）
3. 当前 workspace 名称
4. 当前 MCP server 状态
5. 当前 workspace skills
6. 当前 capability lanes
7. 当前请求的 preferred capability route
8. working directory

当前入口：

1. `apps/sidecar/src/services/agent/agent-prompt-builder.ts`
2. `apps/sidecar/src/services/agent/agent-runtime-context.ts`
3. `apps/sidecar/src/services/pi-agent/runtime-core/run.ts`

当前表现：

1. 通过 `buildDynamicContext()` 构建
2. 通过 `DefaultResourceLoader.appendSystemPromptOverride()` 追加到 runtime session system prompt
3. 会显式暴露 `<session_state>`
4. 会显式暴露当前 capability lanes（如 `skills / browser / memory / web / raw-tools`）
5. 会基于当前用户消息推导 `Preferred capability route` 与 `Capability routing reason`

规则：

1. 只表达“当前这次运行”的状态
2. 不写长期人格规则
3. 不承担 capability policy 的主逻辑

## 4. 线性展开顺序

最终送入模型的 effective prompt 采用如下顺序：

1. **底层 pi 默认 system prompt**
2. **Lume Base Kernel**
3. **Lume Mode Kernel Append**
4. **Lume Capability Policy Layer**
5. **Workspace Persona + Operational Context（以 Project Context 形式注入）**
6. **Runtime Dynamic Context**

说明：

1. 当前实现里，Layer 2/3/5 已包含在 `buildSystemPromptAppend()` 生成结果中
2. Layer 6 由 `buildDynamicContext()` 单独生成并追加
3. 最终由 runtime-core 的 `DefaultResourceLoader` 统一拼接到 pi 默认 prompt 后

## 5. 当前实现入口

### 5.1 Prompt Builder

文件：

1. `apps/sidecar/src/services/agent/agent-prompt-builder.ts`

职责：

1. 生成 Lume kernel 主体
2. 注入 capability policy 段
3. 注入 workspace files 的 `Project Context`
4. 生成 runtime dynamic context

### 5.2 Workspace Context Loader

文件：

1. `apps/sidecar/src/services/system/workspace-bootstrap-service.ts`

职责：

1. 读取 bootstrap 文件
2. 读取 daily memory
3. 处理 `MEMORY.md` / `memory.md` fallback
4. 对 subagent 做文件注入裁剪

### 5.3 Runtime Prompt Injection

文件：

1. `apps/sidecar/src/services/pi-agent/runtime-core/run.ts`

职责：

1. 创建 `DefaultResourceLoader`
2. 使用 `appendSystemPromptOverride()` 追加 Lume prompt
3. 禁用底层默认 `AGENTS.md` 自动发现，避免与 Lume 的 `Project Context` 重复

## 6. 覆盖与追加规则

### 6.1 不允许被 Persona 覆盖的内容

1. 安全规则
2. 权限规则
3. 高风险真实性边界
4. 破坏性操作确认规则

### 6.2 允许 Workspace 自定义的内容

1. 语气
2. 关系风格
3. 外貌与视觉 identity
4. 工作风格偏好
5. 用户背景与长期记忆

### 6.3 允许 Mode Append 改变的内容

1. dev persona
2. automation mode
3. future task preset
4. future output DSL append

限制：

1. 只能追加或收窄，不应破坏 Base Kernel 根规则

## 7. 当前已知缺口

### 7.1 Capability Policy 仍不完整

尚缺：

1. 完整的 `skills-first` 路由契约
2. `search/install skill` 到 fallback 的顺序定义
3. mode-specific output DSL 的统一 append 机制
4. prompt-level routing 到 code-level enforcement 的逐步收口方案

### 7.2 层间边界仍以代码事实为主，文档约束刚建立

风险：

1. 后续修改可能重新把 persona 规则塞回 kernel
2. 也可能把 capability policy 继续散落到多个文件

### 7.3 验证链仍受当前本地环境限制

现状：

1. runtime prompt 注入代码已接入
2. 相关测试已补充
3. 但当前环境下 `bun test` 与 `tsc` 受模块解析/权限问题影响，未完成正式验证闭环

## 8. 后续执行建议

### P0

1. 补齐 `agent-prompt-builder.test.ts` 中对新人格口吻与交互规范的断言
2. 在可用环境中完成 runtime-core prompt injection 测试闭环

### P1

1. 将 Capability Policy Layer 继续体系化
2. 明确 `skills-first` 与 fallback 路由顺序
3. 收敛 mode append 入口，减少 builder 内散点判断
4. 逐步把关键能力路由从 prompt 引导升级到 runtime enforcement

### P2

1. 如果需要更强 companion identity，继续扩展 persona layer，而不是回流到 kernel
2. 如需 infographic / strudel / image-style 等规则，按 mode append 追加，不常驻所有会话

## 9. 结论

Lume 当前不是“没有分层”，而是：

1. 已经形成了六层 prompt 注入架构的雏形
2. Base Kernel、Workspace Context、Runtime Context 已经接通
3. Persona Layer 已经建立
4. Capability Policy 与 Mode Append 仍需进一步制度化

后续工作的重点不再是“把 prompt 写长”，而是把 **层、顺序、职责、追加关系** 持续固化成稳定契约。
