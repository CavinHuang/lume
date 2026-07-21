# ADR-0002：Wiki 默认可读，正式写入必须确认

状态：Accepted
日期：2026-07-21
取代：ADR-0001 中“普通 Agent 的 Wiki 读取依赖 Phase B”的部分

## 背景

0.1.7 中，`agent-wiki` Skill 可以在普通线程加载，但 `wiki.search`、`wiki.read` 和 `wiki.follow_links` 是否注入仍取决于 Phase B 或消息关键词。这会让 Agent 把“当前线程没有工具”误报成“Wiki 整体不可用”，并迫使用户理解内部 capability phase。

Wiki 读取工具已经在服务端执行 thread scope、workspace UUID、page visibility 与 provenance grant 检查。真正可能扰乱知识库的是正式写入，而不是受限读取。

## 决策

- 受信任的本地 direct Agent 线程始终获得 `wiki.search`、`wiki.read`、`wiki.follow_links`。
- IM、群聊、外部主体和不可信 thread source 仍不能因此获得 Wiki scope。
- `wiki.propose_changes` 与只读工具一样保持稳定注入；工具执行时必须同时验证 proposal security gate 已就绪、当前用户消息明确要求写入 Wiki，否则在创建 staging 前拒绝。
- 提案只能写 staging；正式 apply/resolve/undo 继续由 Electron 主进程 privileged channel 执行，并要求用户确认。
- 更新仍绑定 page ID、expected hash 和块 ownership；高风险覆盖、删除与冲突继续进入 pending review。
- Phase B 继续表示通用 shell/process 的 protected-root 隔离能力，但不再控制专用 Wiki 只读工具是否出现。

## 后果

- 普通 Agent 可以自然检索 Wiki，不再需要关键词触发或切换专用线程才能读取当前 scope。
- 用户仍通过明确写入意图和确认卡掌握正式知识变更。
- 每个受信任线程常驻三个只读工具，会增加少量 tool schema token；相比失败重试和错误诊断，这是可接受成本。
