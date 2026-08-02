# Lume 2026 Product Thesis

> Status: Draft
>
> Date: 2026-08-01
>
> Related thinking: [Proma 2026 Q2–Q3 Thinking](https://github.com/proma-ai/Proma/blob/main/proma-thinking/proma-2026-q2-q3-thinking.md)

## 0. Decision summary

### North Star

Lume helps a user continuously move a small number of important work items forward. It remembers the right context, makes progress visible, asks for approval at meaningful boundaries, recovers after interruption, and leaves verified work in the correct place.

### Product position

Lume is not primarily a better chat interface, a larger Skill marketplace, or a collection of autonomous personas. It is a local-first personal execution system:

```text
work signals
  -> candidate task
  -> user-approved task contract
  -> resumable execution
  -> visible interruption or handoff
  -> verified artifact
  -> feedback and durable context
```

### Three product promises

1. **持续**：会话结束、应用重启或渠道切换后，工作不会失去状态。
2. **可见**：用户随时知道任务在做什么、做到哪里、为何停下。
3. **可控**：权限、成本、外部影响和最终产物都可以确认、暂停、撤销或回滚。

## 1. What we learned from Proma

Proma 将 2026 年的重点归纳为 Proactive、个人注意力和团队协作。这三个词真正指向的是三个用户问题，而不是三个功能模块：

| Proma direction | Underlying user problem | Lume translation |
| --- | --- | --- |
| Proactive | 用户不知道哪些重复工作值得自动化，也不希望被低价值消息打扰 | 从真实工作信号发现候选任务，低频提议，确认后执行 |
| Personal attention | 用户无法同时理解多个 Agent、线程和后台任务 | 统一任务中心、mailbox、状态聚合和下一步建议 |
| Team collaboration | 人、Agent、工作区、文件和 Skill 缺少共享上下文与边界 | 先解决单人多 Agent 协作，再扩展到受控共享工作区 |

Proma 对记忆的克制也值得保留：稳定偏好可以保持轻量，严肃工作内容应进入可读文档，流程化知识应沉淀为 Skill。Lume 的多层、结构化记忆可以继续作为内部能力，但用户界面应收敛到三个概念：

- 我的偏好
- 项目知识
- 当前任务状态

“当前任务状态”是 Lume 2026 年需要补强的部分。用户真正希望 Agent 记住的，不只是过去说过什么，而是已经完成了什么、还缺什么、为什么停下以及下一步是什么。

## 2. User problem statement

当前 Agent 产品普遍能够完成局部动作，却难以稳定完成长流程。OSWorld 2.0 在 108 个长流程电脑任务上显示，即使最强配置的严格端到端完成率也只有 20.6%；主要失败来自隐藏状态、跨来源推理、动态变化、约束保持和最终验证，而不是单纯的点击能力。[OSWorld 2.0](https://arxiv.org/abs/2606.29537)

公开反馈也反复出现相同问题：

- 跨会话需要重新解释项目和偏好。[Claude Code memory issue](https://github.com/anthropics/claude-code/issues/27298)
- 后台任务、子 Agent 和任务状态缺少持续可见性。[Codex background task issue](https://github.com/openai/codex/issues/22099)
- 记忆搜索找到正确内容，但 Agent 没有可靠使用它。[OpenClaw memory issue](https://github.com/openclaw/openclaw/issues/57436)
- 权限边界、授权主体和审计仍是 Agent 普遍需要补足的基础能力。[NIST Agent identity and authorization](https://www.nccoe.nist.gov/sites/default/files/2026-02/accelerating-the-adoption-of-software-and-ai-agent-identity-and-authorization-concept-paper.pdf)

因此，Lume 不应把 2026 年的成功标准定义为“能调用多少工具”或“能同时运行多少 Agent”，而应定义为：

> 用户能否在少量人工介入下，让一个真实任务跨越多个会话、多个工具和多个工作日，最终以可验证的结果完成。

## 2.1. 用户真实需求缺口：紧急程度与差异化机会

公开反馈、长流程评测和竞品产品形态共同指向几个稳定缺口。需要区分两类问题：

- **急需解决的问题**：不解决就会让用户不敢长期使用 Agent。
- **差异化机会**：解决后能让用户明显感受到 Lume 与普通聊天 Agent 的不同。

两者并不完全重合。可靠性和权限是全行业都必须补的基础设施，未必天然形成差异化；Lume 的差异化来自于把这些基础设施和本地数据、长期任务、微信入口、可读文件及 Wiki 结合起来。

| 用户缺口 | 紧急程度 | 对 Lume 的差异化价值 | 判断 |
| --- | --- | --- | --- |
| 任务中断后无法继续，需要从头解释 | 极高 | 高 | Lume 应把“可恢复任务”作为核心对象，而不是把恢复能力藏在 SDK 里 |
| Agent 做了什么、为何停下、是否真的完成不清楚 | 极高 | 高 | 需要统一任务状态、证据、验证和产物位置 |
| 权限过度或审批过于频繁 | 极高 | 高 | 本地 Agent 的信任门槛高，必须做到可解释、可撤销、可回滚 |
| 记忆召回不准、上下文跨线程丢失 | 极高 | 高 | Lume 已有结构化记忆，机会在“任务状态 + 来源解释 + 用户修正” |
| 多个后台任务造成注意力切换和信息噪音 | 高 | 很高 | mailbox + 任务中心是较容易被用户立即感知的产品差异 |
| 本地文件、云盘、浏览器登录态和外部应用边界混乱 | 高 | 高 | Lume 的本地优先定位可以转化为清晰的数据与权限边界 |
| 产物重复生成、写错位置、无法回滚 | 高 | 很高 | Wiki 已有 provenance / revision 思路，可推广到普通文件和 Office 产物 |
| 自动化只会定时触发，不会根据反馈变得有用 | 中高 | 高 | 先做低打扰的候选任务发现，不急于做完全自主自迭代 |
| 缺少团队共享上下文和 Skill 同步 | 中 | 中高 | 真实存在，但应晚于单人多任务连续性 |
| 缺少更多角色、更多模型和更多 Skill | 低 | 低 | 这是能力卫生，不是 2026 年的核心产品差异 |

### 最急需解决的三个问题

#### 1. “我能不能把工作交出去？”

用户不是只关心 Agent 能否完成某一步，而是关心把任务交出去后，自己能否暂时离开。长流程中最危险的不是偶尔回答错误，而是 Agent 在错误状态上继续推进，并在最后把错误包装成完成。

因此，Lume 首先需要保证：

- 任务有明确完成标准；
- 中途状态可以查询；
- 失败不会伪装成成功；
- 不可恢复的步骤会明确暴露；
- 最终产物能够复核和回滚。

#### 2. “我能不能放心给它权限？”

本地 Agent 的价值来自更深的文件、程序和账号访问，但风险也因此更高。NIST 将 Agent 身份、最小权限、授权委托、人与 Agent 的绑定和可验证审计列为需要解决的基础问题。[NIST Agent identity and authorization](https://www.nccoe.nist.gov/sites/default/files/2026-02/accelerating-the-adoption-of-software-and-ai-agent-identity-and-authorization-concept-paper.pdf)

Lume 已有工具风险分级、protected root、审批和 trace 基础，但用户需要的是一条完整的信任链：

```text
谁发起
  -> Agent 被授予什么范围
  -> 本次动作影响什么
  -> 哪些数据会外发
  -> 用户在哪个节点批准
  -> 结果能否撤销或恢复
```

#### 3. “我能不能同时管理几个 Agent 而不被拖垮？”

Proma 关于人类注意力上限的判断虽然需要验证，但问题本身是真实的：多个 Agent 并行后，用户会面对更多上下文切换、等待、审批和失败恢复。

Lume 需要帮助用户关注重要任务，而不是把所有后台事件都暴露出来。任务中心、mailbox、优先级和下一步摘要可能比“再增加一个 Agent 角色”更能直接提升体验。

## 2.2. 对当前 2026 目标的复盘

当前 O1–O4 的方向是正确的，但优先级需要明确：O1 和 O2 是当前必须完成的产品基础，O3 是建立在基础之上的体验放大器，O4 是后续扩展方向。

| 当前目标 | 需求判断 | 2026 优先级调整 | 具体建议 |
| --- | --- | --- | --- |
| O1：可持续、可验证的任务 | 最直接的用户痛点，也是 Lume 当前运行时已有投入的延伸 | P0，第一主线 | 从 RunState / Trace / Interruption 继续上升到用户可见的 Task Center 和 Artifact 状态 |
| O2：个人注意力控制面 | 竞品普遍有后台能力，但缺少低认知负担的统一管理 | P0，第一差异化线 | 优先做 mailbox、任务聚合、阻塞解释和下一步，不先做复杂看板 |
| O3：低打扰主动工作 | 用户确实需要，但主动化很容易变成噪音、成本和越权 | P1，建立在 O1/O2 之上 | 先做“发现并提议”，再做“确认后执行”，最后才考虑反馈驱动的 Skill 优化 |
| O4：受控共享上下文和产物 | 对小团队有价值，但不应牺牲单人产品的连续性 | P1/P2，选择性试点 | 优先共享工作区、Skill 和产物，不急于做通用多 Agent 网络 |

### 当前目标中最可能过度建设的部分

1. **过早建设完整团队协作**：如果单人任务仍不能稳定恢复，多用户共享只会放大权限和上下文问题。
2. **过早建设自主 Skill 自我进化**：错误反馈可能被固化为新规则，应先做 Diff、版本、影响范围和人工批准。
3. **过度强调记忆类型**：六类记忆和多层作用域可以保留为内部实现，但不能让用户理解成本超过收益。
4. **过度强调 Agent 数量**：用户需要的是少数任务稳定完成，而不是同时运行更多角色。

## 2.3. 哪些地方可以立刻让 Lume 与众不同

差异化不应依赖训练一个比所有竞品都强的模型，而应依赖 Lume 已经拥有、且竞品通常没有整合好的产品组合。

### 差异化一：可读、可检查、可恢复的本地任务

Lume 可以把每个长期任务的状态、检查点、审批、trace 和产物都保存在用户可理解的本地结构中。用户不仅能“看到聊天”，还能知道：

- 任务当前状态；
- 使用了哪些文件和记忆；
- 哪一步被阻塞；
- 哪个动作需要重新执行；
- 产物写到了哪里；
- 出错时如何恢复。

这比“Agent 正在思考”更接近真实工作需要，也符合 Lume 本地优先的产品根基。

### 差异化二：跨桌面、线程和微信的任务接力

Lume 已经有桌面工作台和微信入口。可以把微信从“聊天渠道”提升为任务控制渠道：

- 桌面开始任务；
- 微信收到阻塞或审批请求；
- 用户在微信确认、暂停或补充信息；
- Lume 回到桌面继续执行；
- 最终结果回到正确的工作区和文件。

真正的差异不是“支持微信”，而是“同一个任务在不同入口之间不丢状态”。

### 差异化三：记忆、项目文件和 Wiki 的来源闭环

Lume 已经分别建设了 Memory、Workspace、Wiki 和文件引用语义。下一步应把它们串成来源闭环：

```text
来源文件 / 对话 / 决策
        -> 项目知识或任务上下文
        -> Agent 执行
        -> 带来源的产物
        -> 用户确认后沉淀
```

这会让 Lume 的记忆不只是“模型可能召回的文本”，而是和项目资料、决策、产物及权限绑定的工作知识。

### 差异化四：低噪声主动性

Lume 不需要比 OpenClaw 更频繁地主动，也不需要每日生成更多摘要。更有差异化的做法是：

> 只有当 Lume 发现一个重复、明确、可验证、能减少用户下一步动作的机会时，才提出自动化建议。

例如：

- 发现每周都在手动检查同一组服务；
- 发现每次发布前都重复执行同一套检查；
- 发现多个反馈都指向同一类问题；
- 发现用户反复从同一批文档生成相似报告。

### 差异化五：把信任机制做成日常体验

Lume 可以把风险分级、工具治理、protected root、审批、trace、Wiki ownership 和回滚能力整合成用户可理解的“行动记录”。

这不是单独的安全功能，而是用户决定是否长期授权本地 Agent 的产品体验。

## 2.4. Lume 应该如何对外表达差异化

不建议对外主打：

- “我们有更多 Agent 角色”；
- “我们有更多 Skill”；
- “我们支持更多模型”；
- “我们可以让 Agent 自己进化”；
- “我们可以无限并行运行 Agent”。

建议主打：

> Lume 是一个本地优先的个人工作系统：它能记住你的项目，持续推进你的任务，在关键动作前征求确认，并把经过验证的结果安全地放回你的工作空间。

更短的产品句子可以是：

> 把重要工作交给 Lume，回来时它还知道做到哪里。

## 3. 2026 objectives

### O1. Make work resumable and verifiable — P0

**User promise**：我可以把任务交给 Lume，离开一段时间后回来，不需要从头解释，也不会把已经完成的部分重新做一遍。

#### Required capabilities

- 统一的 Task Contract，明确目标、范围、完成标准、输入来源和权限边界。
- 运行状态持久化：queued / running / waiting / blocked / resumable / verified / failed / cancelled。
- 工具调用、审批、用户回答和外部变更形成可恢复的检查点。
- 对不可安全重放的步骤明确标记 `not_resumable`，不伪装成已经恢复。
- 最终结果必须经过验证，并说明未完成项、证据和产物位置。

#### Measures

- Verified completion rate：达到完成标准且有验证证据的任务比例。
- Recovery success rate：中断、重启或网络失败后可继续完成的任务比例。
- Restart penalty：恢复任务时用户需要重新说明的内容和重复执行的动作。
- Unverified completion rate：Agent 声称完成但未能证明结果的比例。

#### Non-goals

- 不承诺所有正在运行的进程都能在重启后原地恢复。
- 不通过伪造工具结果来提高表面恢复率。
- 不把聊天消息本身作为唯一任务真源。

### O2. Build a personal attention control plane — P0

**User promise**：我不需要打开所有线程，就能知道哪些事情值得现在关注。

#### Required capabilities

- 统一展示线程、后台子 Agent、自动化和待审批事项。
- Mailbox：只放需要用户判断、授权、补充上下文或接管的事项。
- Board：聚合运行中、阻塞、待验证和已完成的任务。
- 每个任务有一句话状态、当前阻塞点和下一步。
- 相似任务、重复失败和低价值通知自动折叠。
- 支持从微信等外部渠道确认或暂停，再回到桌面继续。

#### Measures

- Status comprehension time：用户理解所有重要任务状态所需时间。
- Attention switches：完成一个工作周期所需的上下文切换次数。
- Pending-age：待用户处理事项在 mailbox 中停留的时间。
- Ignored-task rate：被创建但长期没有有效动作的任务比例。

#### Non-goals

- 不追求同时管理无限数量的 Agent。
- 不把所有后台事件都变成通知。
- 不先做复杂的 Agent Teams 编排。

### O3. Introduce low-noise proactive work — P0

**User promise**：Lume 能发现我反复做的工作，但不会擅自创建一堆自动化。

#### Required capabilities

- 从文件变化、重复操作、日程、任务历史和自动化结果中发现候选模式。
- 先提议，再由用户确认频率、范围、权限、通知和预算。
- 自动化有自己的版本、运行历史、失败原因和反馈记录。
- 失败后优先生成修复建议，不直接悄悄修改 Prompt 或 Skill。
- 允许用户将“不要再建议这类自动化”作为明确偏好。

#### Measures

- Suggestion acceptance rate：候选自动化被用户接受的比例。
- Useful-run rate：运行后产生可执行结果或减少人工步骤的比例。
- Interruption rate：自动化主动打断用户的比例。
- Repeat-failure rate：同一自动化重复失败后仍未被处理的比例。
- Cost per useful outcome：每个有效结果的模型和运行成本。

#### Non-goals

- 不把每天推送新闻、摘要作为主动性的主要目标。
- 不在未经批准的情况下自我修改生产 Skill。
- 不让 Agent 自主扩展权限或创建外部账号。

### O4. Make shared context and artifacts governable — P1

**User promise**：多个 Agent 可以共享工作成果，但不会共享不该共享的私人记忆或权限。

#### Required capabilities

- 工作区、项目、线程、用户和 Agent 的清晰作用域。
- Skill 的版本、依赖、来源、能力声明和回滚。
- 文件、Wiki、Office 产物的来源、版本、Diff 和恢复能力。
- Agent 之间的调用必须绑定调用者、授权范围和目标任务。
- 共享内容和私人内容默认分离，显式授权后才能跨界读取。

#### Measures

- Unauthorized read/write count。
- Artifact recovery success rate。
- Duplicate or wrong-target write rate。
- Skill update rollback rate。
- Shared-context correction rate。

#### Non-goals

- 2026 年不优先构建大规模多 Agent 网络。
- 不在缺少真实场景的情况下追求通用 Agent-to-Agent 协议。
- 不把团队共享等同于所有记忆默认共享。

## 4. Core product model

Lume 的核心对象应从“对话”逐渐扩展为“任务”，但对话仍然是主要入口。

```text
Conversation / file change / schedule / external message
                         |
                         v
                   Candidate Task
                         |
             user confirms scope and authority
                         |
                         v
                    Task Contract
                         |
                         v
                    Task Run(s)
              /          |          \
             /           |           \
       progress      interruption    handoff
             \           |           /
              \          |          /
                         v
                  Verified Artifact
                         |
                         v
               feedback + durable context
```

### Task Contract minimum fields

- `goal`：用户要得到的结果。
- `scope`：允许访问的工作区、文件、账号和渠道。
- `successCriteria`：什么条件下算完成。
- `authority`：哪些动作可以自动做，哪些必须确认。
- `budget`：时间、模型调用、外发消息和费用限制。
- `checkpointPolicy`：哪些阶段必须留下可恢复状态。
- `artifactTarget`：最终结果写回哪里，是否允许创建新文件。
- `provenance`：输入来源、工具动作和验证证据。

### Memory model exposed to users

内部仍可保留 Lume 的结构化记忆，但用户可见层建议只暴露：

| User concept | Examples | Default behavior |
| --- | --- | --- |
| 我的偏好 | 语言、技术栈、交互方式、禁止事项 | 少量常驻，允许编辑和撤销 |
| 项目知识 | 决策、约定、业务规则、重要文档 | 按工作区和任务召回 |
| 当前任务 | 进度、阻塞、下一步、未决事项 | 随 Task Contract 和 Run 更新 |

## 5. Roadmap shape

### Q2 foundation: make state durable

- 统一 Task Contract、RunState、Interruption、Trace 和 Artifact 引用。
- 让后台任务、子 Agent、自动化和普通线程进入同一状态投影。
- 建立 mailbox 和基础任务中心。
- 补足任务状态、阻塞原因、恢复结果和验证结果的 UI 表达。

Lume 当前已经有 RunState、Trace、持久化 interruption、Task Contract、后台子 Agent 和自动化审批等运行时基础。现有架构记录明确列出，全面的重启后执行恢复、handoff 控制转移 UI、丰富的后台任务管理和完整自动化 dashboard 仍是后续工作。[Agent Runtime 能力补足实现记录](../architecture/agent-runtime-capability-completion-plan.md)

### Q3 execution: make attention manageable

- 完成统一任务中心和 mailbox。
- 支持跨线程、跨工作区和跨微信入口的状态接力。
- 引入任务聚合、优先级、相似任务折叠和下一步建议。
- 建立恢复和验证指标，而不是只统计运行次数。

### Q4 proactive and sharing: make useful automation compound

- 从重复工作中提出候选自动化。
- 自动化具备版本、运行健康、反馈和审批链。
- Skill、工作区上下文和产物支持受控共享。
- 选择一个真实的小团队协作场景做试点，不泛化为完整团队平台。

## 6. Product boundaries

Lume 2026 年明确不追求：

- 用人格数量证明 Agent 能力。
- 用 Skill 数量证明生态规模。
- 用并行 Agent 数量证明生产力。
- 用高频通知证明主动性。
- 用模型切换和参数调优掩盖任务恢复问题。
- 在没有权限、审计和回滚基础的情况下扩大自动化范围。

## 7. Open decisions to validate

1. **注意力上限**：三项并行任务是 Proma 开发者的观察，还是 Lume 用户的可重复规律？
2. **任务真源**：Task Contract、Workspace 文件和聊天记录三者如何分工？
3. **主动化授权**：什么类型的自动化可以一次确认长期运行，什么类型必须每次确认？
4. **记忆沉淀边界**：哪些信息自动写入，哪些只能形成候选，哪些必须用户显式确认？
5. **共享边界**：个人 Agent、工作区 Agent、团队 Agent 的权限和记忆如何隔离？
6. **成功定义**：Lume 以节省时间、减少切换、减少重复解释，还是提高可验证完成率作为主要指标？

## 8. Recommended validation set

先用三类真实任务验证，而不是先做完整平台：

1. **长期项目任务**：跨多个工作日持续推进代码、内容或研究项目。
2. **重复信息任务**：定期收集、筛选、总结，并只把需要用户处理的事项放入 mailbox。
3. **多工具执行任务**：跨本地文件、浏览器、Office 或 IM 读取信息，生成并写回一个可验证产物。

每类任务至少记录：

- 是否达到用户定义的完成标准；
- 用户介入了几次；
- 是否因为中断而重复工作；
- 是否写到了正确的目标位置；
- 是否留下足够证据让用户复核；
- Agent 是否主动减少了下一步工作。

## 9. Working conclusion

Lume 2026 年的关键不是“让 Agent 更像一个人”，而是让 Agent 更像一个可靠的工作伙伴：

> 它能记住正确的事，持续推进重要的事，在关键边界请求确认，并对自己的动作和结果负责。

Proma 的三个方向可以成为 Lume 的战略骨架，但需要做一次产品化收敛：

```text
Proactive           -> 低打扰的候选任务发现
Personal Attention  -> 统一任务中心和人工 mailbox
Team Collaboration  -> 受控共享的上下文与产物
```

最终形成 Lume 的产品判断：

> Lume 不是替用户启动更多 Agent，而是帮助用户以更低的认知成本，持续完成少量重要工作。
