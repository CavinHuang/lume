# Lume 2026 O1：可持续、可验证的任务

> Status: Draft
>
> Date: 2026-08-01
>
> Parent thesis: [Lume 2026 Product Thesis](./lume-2026-product-thesis.md)

## 0. O1 definition

O1 的核心不是“支持所有任务重启后原地恢复”，而是：

> 用户把任务交给 Lume 后，即使发生中断、重启、等待确认或工具失败，也能基于已有状态继续完成，而不是重新解释、重新规划、重新执行。

正确的产品承诺是：

> Lume 不会让用户因为一次中断而失去任务上下文；它会继续、重新规划、请求接管，或者明确告诉用户无法安全恢复。

不承诺所有工具、Shell 进程、浏览器状态和外部动作都能原地恢复。

## 1. Core model

```text
Task Contract
    ↓
Task Run / 状态机
    ↓
Checkpoint / 中断点
    ↓
Resume / Replan / Manual takeover
    ↓
Verification
    ↓
Artifact + Evidence
```

| 对象 | 解决的问题 |
| --- | --- |
| Task Contract | 用户到底想完成什么 |
| Task Run | 这次执行进行到哪里 |
| Checkpoint | 中断后从哪里继续 |
| Interruption | 为什么需要等待用户 |
| Verification | 如何证明完成 |
| Artifact | 最终结果在哪里 |

## 2. Work package A：Task Contract

### Goal

把“任务”从聊天记录中抽出来，成为可以跨线程、跨渠道、跨运行持续存在的对象。

### Minimum contract

```ts
type TaskContract = {
  id: string
  goal: string
  scope: {
    workspaceId?: string
    threadId?: string
    paths?: string[]
    channels?: string[]
  }
  successCriteria: string[]
  authority: {
    allowedActions: string[]
    requiresApproval: string[]
  }
  budget?: {
    maxDurationMs?: number
    maxModelCalls?: number
  }
  artifactTarget?: {
    path?: string
    mode: "create" | "update" | "draft"
  }
  status: "draft" | "approved" | "cancelled" | "completed"
}
```

### Required work

- 普通聊天任务、自动化任务、子 Agent 任务和微信任务都能关联 Task Contract。
- Contract 与 Workspace、Thread、Run、Artifact 有明确关联。
- 用户修改目标后产生新版本，不直接覆盖历史意图。
- 任务取消后，后续 Run 不得继续推进。
- Contract 明确完成标准、权限范围和产物目标。

### Current Lume baseline

- 已有 `TaskContractWrite`。
- Plan Mode 已有任务契约和计划审批。
- 已有 `TaskRun` 基础执行路径。

### Acceptance

用户可以回答：

- 这个任务的目标是什么？
- 允许 Agent 操作哪些范围？
- 什么条件下算完成？
- 最终结果应该写到哪里？
- 这次执行属于哪个任务？

## 3. Work package B：unified Task Run state

### Recommended states

```text
created
  ↓
queued
  ↓
running
  ├── waiting_for_user
  ├── waiting_for_approval
  ├── blocked
  ├── failed
  └── completed
              ↓
          verified
```

Additional states:

- `paused`：用户主动暂停；
- `cancelled`：用户取消；
- `resumable`：存在安全继续路径；
- `not_resumable`：不能原地继续，但可以重新规划；
- `stale`：进程消失，状态可能过期。

### Required work

统一以下运行入口的状态投影：

- 普通 Agent 运行；
- 后台子 Agent；
- Automation Run；
- Plan 执行；
- 浏览器 handoff；
- 文件写入和验证。

用户不应该看到五种不同的“运行中”，而应该看到一个统一任务状态，例如：

> 竞品调研进行中，已完成资料收集，正在等待你确认报告范围。

### Current Lume baseline

- 已有 file-backed `RunState`。
- 已有 `RunItems` 和 `LumeRunEvent`。
- 已有 Trace 和历史运行查询。
- 已有后台子 Agent 和自动化等待审批状态。

### Acceptance

无论任务从哪里发起，用户都能看到：

- 当前状态；
- 最近动作；
- 当前阻塞点；
- 下一步；
- 是否需要用户操作；
- 是否可以继续、暂停、取消或重试。

## 4. Work package C：Checkpoint and continuation

### Principle

保存的是任务语义上的检查点，不是试图保存全部进程内存。

很多外部动作无法安全重放：

- 已发送的邮件；
- 已提交的表单；
- 正在运行的 Shell 进程；
- 已被外部系统改变的网页；
- 已经写入的文件；
- 第三方 API 的非幂等调用。

### Resume strategies

```text
continue          从检查点安全继续
replan            状态已变化，需要重新规划
wait              等待用户或外部系统
manual_takeover   需要用户接管
not_resumable     无法安全恢复
```

### Checkpoint minimum

- Task Contract 版本；
- Run ID / Attempt ID；
- 已完成步骤；
- 最后一个可信工具结果；
- 已创建的 Artifact；
- 已获得的用户回答；
- 已批准或拒绝的权限；
- 当前未完成动作；
- 外部状态变化风险；
- 推荐恢复策略。

### Current Lume baseline

- 已有 continuation checkpoint。
- 已有 `ResumeService` 和 `agent:resume-run`。
- AskUserQuestion 已支持冷启动继续。
- 无法安全恢复时会返回 `not_resumable`。

### Required sequence

1. AskUser 中断后恢复；
2. 计划审批后继续或重新规划；
3. 纯读取工具失败后的继续；
4. 已生成 Artifact 后继续后续验证；
5. 幂等写入操作的重试；
6. 不可恢复动作的人工接管；
7. 最后再考虑复杂进程恢复。

## 5. Work package D：Interruption as a first-class state

### Interruption types

```text
waiting_for_approval
waiting_for_user
waiting_for_auth
waiting_for_external_state
waiting_for_manual_takeover
```

### Every interruption must explain

- 原因；
- 需要用户做什么；
- 影响范围；
- 如果拒绝会发生什么；
- 是否可以稍后处理；
- 是否可以改为重新规划；
- 关联的 Task、Run 和 Artifact。

### Product requirement

权限审批不能只显示：

> Allow Bash?

而应说明：

> Lume 想要在 `project-a/src` 中修改 3 个文件，用于修复测试失败。修改前会生成 Diff，拒绝后任务会转为重新规划。

## 6. Work package E：Verification

### Verification states

```text
not_required
unverified
verified
failed
```

### Verification by task type

| Task type | Verification |
| --- | --- |
| 代码修改 | 测试、类型检查、Diff、构建 |
| 文件整理 | 文件数量、目标路径、重复项、清单 |
| 调研报告 | 来源链接、覆盖范围、结论与证据 |
| Office 文档 | 文件可打开、结构检查、渲染检查 |
| 自动化任务 | 目标系统状态、输出记录、发送结果 |
| 浏览器任务 | 页面最终状态、截图或结构化结果 |
| Wiki 写入 | ownership、revision、provenance、冲突检查 |

### Required verification record

每个 Task Run 完成时记录：

- 是否执行验证；
- 使用了什么验证方法；
- 验证输出；
- 验证失败是否修复；
- 哪些结果仍未经验证；
- 用户是否需要最终确认。

不能只显示：

> Task completed.

应显示类似：

> 已完成文件整理。已处理 428 个文件，发现 3 个重复文件未自动删除；目标目录检查通过，报告已保存到 `整理报告.md`。

## 7. Work package F：Artifact and evidence

### Artifact fields

- 唯一 ID；
- 目标路径；
- 来源 Run；
- 创建或修改模式；
- 版本；
- Diff；
- 验证状态；
- 是否需要用户确认；
- 回滚方式。

### Artifact states

```text
planned
drafted
written
verified
published
rolled_back
conflicted
```

### Required work

- 不能只生成同名新文件；
- 不能让用户猜哪个文件是最终版本；
- 不能静默覆盖用户修改；
- 写入冲突要转成明确的用户决策；
- 每个产物都能追溯到对应任务和来源。

### Current Lume baseline

- 已有 session artifacts。
- 已有 FileRef 和 Artifact viewer。
- Wiki 已有 revision / provenance。
- 已有文件边界保护和部分 coding verification。

需要把这些能力推广到普通 Agent 任务，而不是只在代码任务或 Wiki 路径中分别实现。

## 8. User surface: Task Center before complex Kanban

第一版不需要完整项目管理软件，只需要一个统一任务中心。

### Task list

- 任务标题；
- 当前状态；
- 最近活动时间；
- 当前 Agent；
- 需要用户操作的原因；
- 是否可恢复；
- 产物位置。

### Task detail

- 目标；
- 任务范围；
- 已完成步骤；
- 当前步骤；
- 阻塞原因；
- 验证结果；
- Artifact；
- 运行轨迹摘要；
- 操作按钮。

### User actions

```text
继续
暂停
取消
重试
重新规划
接管
查看产物
查看证据
```

### Current Lume baseline

Lume 已有 TracePanel、Run Selector、运行事件投影，但它更偏诊断和调试界面，还不是完整的用户任务中心。

实现原则：

> 不再建立第二套运行系统，而是把已有 RunState、Trace、Interruption 和 Artifact 投影成用户能理解的 Task Center。

## 9. Delivery sequence

### O1-A：统一任务对象

- 扩展 Task Contract；
- 建立 Task / Run / Attempt / Checkpoint 关系；
- 普通聊天、自动化、子 Agent 统一关联；
- 统一状态枚举；
- Task ID 支持跨线程和渠道使用。

### O1-B：建立可恢复状态闭环

- AskUserQuestion；
- 任务审批；
- 权限审批；
- 纯读取失败；
- 生成 Artifact 后继续；
- 自动化等待用户；
- 对不可恢复情况提供重新规划或人工接管。

### O1-C：建立验证与产物闭环

- 通用 Verification Record；
- Artifact 与 Run 绑定；
- 写入 Diff；
- 结果状态；
- 失败后的修复或回滚；
- 未验证结果不能显示为 verified。

### O1-D：建立 Task Center

- 任务列表；
- 任务详情；
- 待处理事项；
- 恢复、暂停、取消；
- 证据和产物入口；
- 跨微信的简单审批和状态查询。

## 10. Test matrix

| Scenario | Expected result |
| --- | --- |
| 模型响应中断 | 任务变成可恢复或明确失败 |
| AskUser 后重启 | 用户回答后继续执行 |
| 权限审批后重启 | 不重复执行危险动作，安全继续或重新规划 |
| Bash 执行中崩溃 | 不伪造完成，明确不可恢复或重新规划 |
| 写文件后验证失败 | 保留 Artifact 和错误证据，可继续修复 |
| 外部文件被用户修改 | 检测冲突，不静默覆盖 |
| 自动化等待审批 | 任务保持等待，不被重复触发 |
| 子 Agent 完成后主任务重启 | 主任务能读取子任务结果 |
| 网络断开 | 保留状态和重试策略 |
| 用户取消任务 | 后续队列和自动恢复均停止 |

## 11. Success metrics

- **Verified completion rate**：真实完成且经过验证的任务比例。
- **Recovery success rate**：中断后无需从头重做的任务比例。
- **Restart penalty**：重启后用户需要重新解释的内容。
- **Duplicate action rate**：恢复过程中重复执行外部动作的比例。
- **Unverified completion rate**：没有证据却显示完成的比例。
- **User intervention count**：每个任务需要用户介入的次数。
- **Time to understand status**：用户理解任务状态所需时间。
- **Wrong artifact rate**：产物写错位置或生成重复副本的比例。

## 12. Non-goals

- 不承诺所有正在运行的进程都能在重启后原地恢复。
- 不通过伪造工具结果提高表面恢复率。
- 不先做分布式队列或大规模 Agent Teams。
- 不在没有幂等、权限和审计基础时扩大自动化范围。
- 不把完整 Trace 调试能力直接等同于用户任务体验。
- 不为了 O1 重新设计已有 Memory、Wiki 或 Automation 系统；优先做统一引用和状态投影。

## 13. Final decision

O1 的实际交付不是一个“恢复按钮”，而是一套任务连续性协议：

```text
明确目标
  -> 持久化状态
  -> 保存安全检查点
  -> 中断时可解释
  -> 恢复、重新规划或接管
  -> 验证结果
  -> 产物可追溯、可回滚
```

如果用户在任务中断后仍然需要重新解释背景、重新确认已完成步骤、重新寻找产物，O1 就没有完成。
