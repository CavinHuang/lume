# ADR-0001: Phase A 的 Ask Wiki 可以生成变更草案

- Status: Accepted
- Date: 2026-07-20

## Context

Ask Wiki 既承担知识检索，也承担用户明确要求的知识整理与沉淀。原计划把 Phase A 的专用会话限制为只读，导致用户即使从 Wiki 功能页明确要求沉淀，也只能得到无法进入正式确认流程的文本草稿。

Phase A 尚未证明普通 Agent 会话中的通用文件和命令工具可以与中央 Wiki 根可靠隔离，因此不能把完整 Wiki 能力开放给普通会话。但专用 Ask Wiki profile 本身不包含这些通用工具，正式提交由不可变草案、本地 Owner UI 和 Agent 执行通道不可访问的桌面主进程确认边界控制。

## Decision

专用 Ask Wiki 会话在 Phase A 和 Phase B 都可以调用受保护的 `wiki.propose_changes`，但只有公开摘要、块级操作、草案配额、privileged channel 和跨通道测试组成的 proposal security gate 全部通过后才启用；否则专用会话保持只读并显示原因。提案只能创建不可变 staging 草案，不能直接提交正式 Wiki。模型可见结果不包含 nonce 或确认凭证；正式写入只允许本地 Owner UI 经 Electron 主进程 privileged channel 触发，Agent 的 Bash、node-repl、网络和通用 RPC 均不能到达 apply。

首版本地单用户产品信任本地 Owner UI，但不信任 Agent runtime、工具参数、网页内容、外部消息及其子进程。sidecar 内部 nonce 只保证草案不可变、过期和防重放，不证明用户意图；用户意图由可信 Owner UI 的确认动作和隔离的主进程通道表达。

普通 Agent 会话仍遵循 capability matrix：Phase A 不获得 Wiki 读取能力；只有 `proposalSecurityGate=passed` 且当前用户消息明确要求沉淀时，才临时获得 create-only 提案能力。Phase B 只有在平台隔离验收通过后才开放作用域内读取和更新提案。

## Consequences

- 用户可以在 Wiki 功能页完成“检索—整理—确认沉淀”的闭环。
- Phase A 的安全边界从“完全只读”变为“可暂存、不可直接提交”，需要持续测试草案不可绕过确认。
- 专用 Wiki profile 与普通 Agent profile 的能力不再对称，runtime 和发布测试必须分别覆盖。
- 桌面主进程与 sidecar 需要维护不向 renderer 或 Agent 子进程暴露的 privileged 会话凭证；若该隔离无法证明，Ask Wiki 只能保持只读。

## Alternatives considered

- Phase A 保持 Ask Wiki 完全只读：边界更简单，但无法完成 Wiki 的核心沉淀工作流。
- 提案也延迟到 Phase B：把受保护草案能力错误地绑定到通用 shell 隔离进度，延长了不必要的功能缺口。
