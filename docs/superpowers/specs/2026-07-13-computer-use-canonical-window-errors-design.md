# Computer Use canonical Window 错误链修复设计

## 背景

会话 `1e4a894b-9aef-405a-a913-396ff9d33116` 中，`get_window_state` 接受了历史目标
`{ id: 102894726, app: "Weixin.exe" }`，随后返回新的 canonical Window，其 `app` 是完整可执行文件路径。
Agent 没有用 `state.window` 替换旧目标，导致每个输入动作都被 Desktop Host 的窗口身份校验拒绝。

真实的 `window identity changed before dispatch` JSON-RPC 错误又被 Sidecar 转换成非空的
`{ status: "unavailable" }`；动作层最终用 `Computer Use v3 input methods must return null`
覆盖了原始错误。Agent 因此把 Tool Error 误解成正常的 `null` 返回并继续重试。动作账本中的八个动作
均停在 `failed`，没有进入 `dispatched`。

## 目标

- 保持 Codex Window2 的严格 canonical Window 身份语义。
- 将 Host 的业务错误和 stale-target 错误原样送达 Computer Use 工具调用方。
- preflight 失败时在确认和动作分派前终止。
- `click` 只允许 `element_index` 或 `x+y` 其中一种目标表达。
- 为本次跨 Host、Sidecar 和工具层的故障链增加定向回归测试。

## 非目标

- 不按窗口 `id` 自动接受或修正不匹配的 `app`。
- 不降低 Host 的窗口身份、截图缓存或元素快照校验。
- 不修改微信输入、SendInput、WGC 或 DPI 坐标实现。
- 不新增依赖，不改动公共 Window2 工具集合。
- 不依靠 Prompt 修改替代运行时错误处理。

## 设计

### Host 错误边界

`DesktopHostRpcClient` 继续将 JSON-RPC `error` 转成 rejected Promise。
`createDesktopHostInvoker` 只把无法配置或无法连接 Host 的情况表达为 `unavailable`；已经连接后的
JSON-RPC 业务错误必须继续抛出，不得转换成普通返回值。

为避免把连接错误和业务错误混为一谈，客户端错误携带可判别的错误类别。业务错误保留 Host 的原始
message；连接建立、断开和超时错误仍可由 Desktop Context 的诊断接口转换成 unavailable 状态。
Computer Use 公共动作始终通过 Tool Error 暴露失败，不在成功返回中泄漏 Lume 状态对象。

### preflight 与动作分派

`desktop_context.preflight_action` 失败时，`preflightAction` 不再吞错并返回空对象。失败在创建确认请求
和动作账本 `confirmed` 阶段前结束。若 Host 返回 stale target，错误信息明确要求调用方使用最近一次
观察返回的 `state.window`，或重新执行 `list_apps/list_windows → get_window`。

输入动作只有在 Host 精确返回 JSON `null` 时推进到 `dispatched`。如果调用边界意外返回普通对象，
工具优先呈现对象中的明确 `message`，而不是统一替换为 `must return null`。

### 点击目标互斥

`click` schema 改为真正互斥的两种形态：

1. `window + element_index`，可附带 click count 和 button；不能带 `x/y`。
2. `window + x + y`，可附带 screenshot ID、click count 和 button；不能带 `element_index`。

运行时在 schema 校验之外保留同样的轻量校验，防止非标准调用方绕过 MCP schema。
Host 继续保持语义元素优先，但不再收到含两种目标的歧义请求。

### Agent 使用语义

现有 Prompt 已明确要求观察后采用 `state.window`，本轮不增加重复文案。正确链路保持为：

`list_apps → get_window → get_window_state → 使用 state.window 输入 → 显式观察验证`

历史 desktop context 只提供应用和标题提示，不能直接作为动作目标。真实 Tool Error 不得被模型当成
`null` 成功；只有工具成功结果中的 JSON `null` 才表示 OS 输入已经分派。

## 数据流

1. Agent 观察历史或 canonical Window。
2. Host 返回最新 `state.window`。
3. Agent 若错误地复用旧 Window，preflight 的严格身份校验返回 stale-target JSON-RPC error。
4. RPC client 保留错误类型和 message，Sidecar 不将其包装为成功对象。
5. Computer Use 工具返回 Tool Error，账本在 `planned` 后标记 `failed`，不请求确认、不分派动作。
6. Agent 使用错误提示重新获取并采用 canonical Window。
7. 正确 Window 的动作由 Host 返回 `null`，账本推进到 `dispatched`；后续观察决定是否 verified。

## 测试策略

### Sidecar Host client/runtime

- JSON-RPC 业务错误保持 rejected Promise，并保留原始 message。
- 未配置、连接失败、连接断开和超时仍有可判别的连接错误行为。
- 权限诊断接口仍能把连接不可用转换成诊断响应。

### Computer Use 工具

- preflight stale-target 时不创建确认请求、不调用实际动作，并将原始错误写入 ledger。
- 动作边界的明确错误 message 不被 `must return null` 覆盖。
- Host 返回 `null` 时仍得到公共 `null` 成功结果。
- `click` 同时携带 `element_index` 与 `x/y` 时被拒绝；两种合法形态分别通过。

### Host contract

- `get_window_state` 可返回更新后的 canonical `state.window`。
- 使用旧 `app` 的动作返回 stale-target；使用 `state.window` 的同一动作返回 `null`。

只运行涉及 Computer Use、Desktop Host client/runtime 和 Windows Host contract 的定向测试。

## 验收标准

- 复现会话中的旧 `Weixin.exe` 目标时，Agent 得到明确的 stale-target Tool Error，而不是
  `Computer Use v3 input methods must return null`。
- stale-target 不弹出动作确认，不产生 OS 输入。
- 使用观察返回的完整 canonical Window 后，`click/type_text/press_key/activate_window` 成功返回 `null`。
- click 的元素目标和坐标目标无法同时提交。
- 正确链路下微信输入框可被点击并输入草稿；发送仍需动作时确认和重新观察验证。

## 剩余风险

- 模型仍可能忽略 `state.window`，但会收到可恢复且准确的错误，不会误判成已分派。
- 微信 UIA 树仍只暴露自绘 pane，坐标点击仍依赖最新截图与正确 DPI 变换。
- 连接错误分类若覆盖不完整，可能把真正的 Host 断开作为普通 Tool Error 暴露；定向测试需要覆盖该边界。
- 真实微信发送结果仍需要用户环境中的端到端观察验证。
