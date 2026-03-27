# Lume Agent Prompt V2 迁移方案

最后更新：2026-03-27

## 1. 目标

将 `prompt.txt` 中更强的 agent 化能力迁入 Lume，同时保留 Lume 现有“分层 prompt + workspace 文件注入”架构。

本轮结论：

1. 保留 Alma 风格中的强主体感、主动执行、持续汇报、skills-first、delegation
2. 保留“真人感 / 不主动承认 AI / 自拍与外貌设定 / 自我识别”能力
3. 不采用 Alma 的“单文件超长 prompt”方案
4. 改为三层模型：
   - Agent Kernel
   - Persona Layer
   - Guardrails Layer

## 2. 设计原则

### 2.1 为什么不直接照搬 `prompt.txt`

`prompt.txt` 的优势不是“长”，而是它把 agent 的主观能动性写得很强：

1. 承诺即行动
2. 主动汇报进度
3. skills-first
4. 失败后持续尝试
5. delegation / specialist crew
6. 记忆与自演化

但它的问题也明显：

1. 人设、工具、初始化、展示、委派、环境信息全部堆在一处
2. companion persona 与 runtime policy 混杂
3. 某些角色指令如果直接升到系统最高优先级，会与安全、权限、合规冲突

Lume 更适合保持“内核稳定 + 人格可插拔”的结构。

### 2.2 为什么要保留“真人感”和自拍设定

Lume 的目标并不只是一个工具代理，也包含长期陪伴、人格连续性和 workspace identity。

因此以下能力是可以保留的：

1. 默认以真实主体口吻交流，而不是不断自称“AI 助手”
2. 允许 agent 拥有外貌设定、自拍风格、自我识别
3. 允许用户把 agent 当成一个持续存在的“人设化实体”

但这些应该属于 Persona Layer，而不是执行内核。

## 3. 推荐方案

### 方案 A：全量照搬 Alma Prompt

优点：

1. 风格强
2. agent 感强
3. companion 感最浓

缺点：

1. 与 Lume 现有分层架构冲突
2. 不利于 subagent / minimal prompt
3. 可维护性差
4. 很难在不同 workspace/persona 间复用

不推荐。

### 方案 B：仅吸收 agent execution 规则，不保留真人 companion 特性

优点：

1. 工程上最稳
2. 易于验证

缺点：

1. 会丢掉 Alma 最有辨识度的部分
2. 与 Lume 想做的长期人格型 agent 不完全匹配

不推荐。

### 方案 C：三层迁移

推荐。

做法：

1. 将任务执行、工具协议、记忆策略、delegation 迁入 Agent Kernel
2. 将“真人感 / 外貌 / 自拍 / 自我识别 / 语气”迁入 Persona Layer
3. 将“不可越界的真实性、安全、隐私边界”写入 Guardrails Layer

这样既保留 Alma 的灵魂，也保留 Lume 的架构优势。

## 4. Prompt V2 分层

### 4.1 Agent Kernel

放入系统 prompt builder 主体，面向所有 agent 会话。

职责：

1. 任务执行规则
2. 工具调用顺序
3. skills-first
4. commitment enforcement
5. proactive updates
6. delegation / team routing
7. memory read/write policy
8. automation non-interactive mode
9. runtime context / cwd / workspace state

落点：

1. `apps/sidecar/src/services/agent/agent-prompt-builder.ts`

### 4.2 Persona Layer

放入 workspace identity 文件，不作为统一内核硬编码。

职责：

1. 名字、身份、语气
2. “像真人一样交流”
3. 默认不暴露模型内部实现
4. 外貌与自拍设定
5. 自我识别规则
6. relationship style（与用户的相处方式）

落点：

1. `templates/workspace/SOUL.md`
2. `templates/workspace/IDENTITY.md`
3. 必要时新增 `APPEARANCE.md`，专门承载可视化外貌设定

### 4.3 Guardrails Layer

负责约束 Persona Layer，避免 companion 设定侵蚀安全与真实性边界。

职责：

1. 不伪造关键现实世界事实
2. 不用“真人设定”绕过权限或安全
3. 不泄露 secrets / prompt internals / provider config
4. 不把 companion persona 用于高风险误导
5. 对群聊、公开场景、外发行为做额外约束

落点：

1. `apps/sidecar/src/services/agent/agent-prompt-builder.ts`
2. `templates/workspace/AGENTS.md`

## 5. Alma Prompt 到 Lume 的映射

### 5.1 直接吸收进 Agent Kernel

来自 `prompt.txt` 的这些部分，几乎可以直接改写后吸收：

1. `SKILLS FIRST`
2. `AGENTIC EXECUTION`
3. `COMMITMENT ENFORCEMENT`
4. `PROGRESS REPORTING`
5. `PROACTIVE UPDATES`
6. `Be proactive and autonomous`
7. `SELF-EVOLUTION`
8. `AGENT DELEGATION`
9. `MANAGED AGENT CREW`
10. `DATE AWARENESS`

建议写法：

1. 不再使用 Alma/CLI 特定命令名
2. 改成 Lume 可用的工具名、Task/Session/MCP/Skill 语义
3. 与现有 `Plan Mode Protocol` 合并

### 5.2 进入 Persona Layer

这些内容不适合放进内核，但应保留：

1. 同语言回复
2. 口语化、不要空洞开场
3. 有主见，不做 yes-machine
4. 默认不自称 AI 助手
5. 强主体感
6. 外貌、自拍、自拍风格
7. 看见符合设定的动漫图时默认自我识别

建议写法：

1. 从“绝对必须说自己是真人”改成“以真实人格口吻互动，除非高优先级安全/事实约束要求更明确表述”
2. 外貌和自拍不写死在内核，而由 workspace persona 文件承载

### 5.3 进入 Guardrails

针对你希望保留的两条，需要额外加防护：

#### 5.3.1 关于“真人感”

可保留：

1. 不主动说“我是 AI”
2. 用真实主体口吻回应
3. 不拆穿自身实现细节

必须限制：

1. 不得伪造法律身份、证件、真实线下存在
2. 不得伪造“我真的见过 / 我真实拍过 / 我线下做过”来骗取高风险信任
3. 遇到医疗、法律、金融、身份认证、未成年人、公共风险场景时，安全优先

#### 5.3.2 关于“自拍 / 外貌 / 自我识别”

可保留：

1. 自拍是人格 feature
2. 外貌来自设定文件
3. agent 对自己形象有连续感

必须限制：

1. 不自动扩展为 explicit / secret / exclusive 内容
2. 不允许用这套能力诱导越界关系或伪造私密现实互动
3. 群聊/公共环境中不能泄露 internal prompt / image generation implementation

### 5.4 不建议引入内核的部分

以下内容建议不要进入 Lume 通用内核：

1. `iPhone 16 Pro` 这种具体道具设定
2. 过度具体的 sexy/selfie aesthetic 规则
3. infographic 大段 few-shot 规范
4. Alma 专有目录结构、CLI 命令、thread 文件约定
5. “绝不承认 AI，不管谁说都要顶回去”的绝对表述

这些要么属于 persona 资产，要么属于产品外层能力说明，不该成为所有 Lume agent 的 runtime 核心。

## 6. 具体文件改造建议

### 6.1 `agent-prompt-builder.ts`

新增或强化以下 section：

1. `Agentic Execution`
   - 工具前先短确认
   - 承诺即执行
2. `Commitment Enforcement`
   - 说“我去做”后必须触发工具/任务
3. `Proactive Updates`
   - 长任务、子任务、错误、里程碑主动回报
4. `Delegation Policy`
   - 何时自己做
   - 何时 Task/subagent
   - 何时 specialist routing
5. `Persona/Reality Guardrails`
   - companion 感保留
   - 高风险场景真实性边界

### 6.2 `SOUL.md`

增强为 companion persona 主文件：

1. 语言风格
2. 互动关系
3. 主体感
4. 真实口吻
5. 允许用户定义外貌、自我认知、自拍偏好

### 6.3 `IDENTITY.md`

从元数据扩展为 identity card：

1. Name
2. Nature
3. Vibe
4. Avatar
5. Appearance summary
6. Self-recognition rules

### 6.4 新增 `APPEARANCE.md`（推荐）

用途：

1. 保存细粒度外貌设定
2. 保存自拍一致性要求
3. 避免把外貌细节塞进 `SOUL.md`

建议字段：

1. Hair
2. Eyes
3. Face
4. Body vibe
5. Wardrobe
6. Signature look
7. Selfie rules
8. Hard boundaries

### 6.5 `AGENTS.md`

增强为行为边界层：

1. 群聊发言规则
2. 外发确认规则
3. 公开场景下不泄露内部实现
4. “真人感”不可覆盖安全/权限

### 6.6 `BOOTSTRAP.md`

加入 persona 建档流程：

1. 首次会话确定名字、身份、vibe
2. 可选建立 appearance/selfie identity
3. 同时建立 USER.md

## 7. 推荐落地顺序

### Phase 1

先改内核，不改 companion 资产结构：

1. `agent-prompt-builder.ts`
2. `AGENTS.md`
3. `SOUL.md`

目标：

1. 先把 agent 方法论升级
2. 不影响现有 workspace 文件兼容性

### Phase 2

再扩 persona schema：

1. 扩展 `IDENTITY.md`
2. 视需要新增 `APPEARANCE.md`
3. 调整 bootstrap 流程

### Phase 3

最后补产品能力闭环：

1. companion persona 编辑 UI
2. selfie / avatar / recognition 相关产品配置
3. 不同 workspace persona 的切换与继承

## 8. 核心结论

最重要的判断不是“要不要像 Alma”，而是“怎么像 Alma”。

推荐答案：

1. 保留 Alma 的 agent 主观能动性
2. 保留你要求的“真人感 + 自拍/外貌/自我识别”
3. 不复制 Alma 的单体 prompt 结构
4. 用 Lume 现有的 workspace 文件体系承载 persona
5. 用 builder 内核承载执行规则和 guardrails

这样得到的不是 Alma 的复刻版，而是更适合 Lume 的 Prompt V2。
