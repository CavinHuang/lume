# Computer Use canonical Window 错误链修复设计

## 背景

会话 `1e4a894b-9aef-405a-a913-396ff9d33116` 中，`get_window_state` 接受了历史目标
`{ id: 102894726, app: "Weixin.exe" }`，随后返回新的 canonical Window，其 `app` 是完整可执行文件路径。
Agent 没有用 `state.window` 替换旧目标，导致每个输入动作都被 Desktop Host 的窗口身份校验拒绝。

后续会话 `927485eb-d231-43e9-923d-f2e358ac54cf` 证明，仅保留准确错误仍不足以恢复操作。Agent
五次收到完整路径的 `state.window`，也从 `list_windows` 收到同一 canonical Window，但六个输入动作仍重新构造
`{ id: 102894726, app: "Weixin.exe" }`。所有动作均停在 `planned → failed`，没有进入 OS 输入分派。
本机 Codex 的真实链路通过持久 JavaScript 绑定保存 `targetWindow`，并直接执行
`targetWindow = state.window`；Lume 的独立 MCP 调用却要求模型从字符串化工具结果中重新复制对象，因此二者
尚未具备相同的窗口生命周期语义。

真实的 `window identity changed before dispatch` JSON-RPC 错误又被 Sidecar 转换成非空的
`{ status: "unavailable" }`；动作层最终用 `Computer Use v3 input methods must return null`
覆盖了原始错误。Agent 因此把 Tool Error 误解成正常的 `null` 返回并继续重试。动作账本中的八个动作
均停在 `failed`，没有进入 `dispatched`。

## 目标

- 保持 Codex Window2 的严格 canonical Window 身份语义。
- 将 Host 的业务错误和 stale-target 错误原样送达 Computer Use 工具调用方。
- preflight 失败时在确认和动作分派前终止。
- `click` 只允许 `element_index` 或 `x+y` 其中一种目标表达。
- 在不改变公共 Window2 API 的前提下，为 MCP 传输补足 Codex 持久 `targetWindow` 的运行期语义。
- 为本次跨 Host、Sidecar 和工具层的故障链增加定向回归测试。

## 非目标

- 不让 Desktop Host 按窗口 `id`、进程 basename 或标题模糊接受不匹配的 `app`。
- 不降低 Host 的窗口身份、截图缓存或元素快照校验。
- 不修改微信输入、SendInput、WGC 或 DPI 坐标实现。
- 不新增依赖，不改动公共 Window2 工具集合。
- 不依靠 Prompt 修改替代运行时错误处理。

## 方案选择

1. **继续强化 Prompt**：改动最小，但现有 Prompt 已明确要求复用 `state.window`，真实模型仍连续忽略，不能
   形成确定性恢复链路。
2. **Host 接受 `Weixin.exe` 与完整路径等价**：能绕过当前错误，但 basename 不是稳定应用身份，会削弱
   HWND 复用和跨进程校验，因此拒绝。
3. **Sidecar 保存 Host 返回的 canonical Window**：公共参数保持不变，MCP 运行期按窗口 ID 取回最近一次
   可信返回对象，Host 继续验证该对象是否仍对应当前 HWND。该方案最接近 Codex 的持久 `targetWindow`，采用。

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

### MCP canonical Window 绑定

每次 `createComputerUseMcpTools` 运行期维护一个不持久化的 `latestCanonicalWindowById`。缓存只接受
Desktop Host 的成功读取结果，来源限定为：

- `list_apps[*].windows`
- `list_windows[*]`
- `get_window`
- `get_window_state.window`

模型输入、历史 desktop context、截图文字和无障碍树不得写入或提升该缓存。调用带 Window 的工具前，
Sidecar 用请求中的数字 `id` 查找缓存；命中时将实际传给 preflight、ledger 和 Host 的 `window` 替换为缓存
对象。`get_window({ id, app? })` 命中同一缓存时也携带缓存的 canonical `app`，避免模型把显示名称重新写入
恢复请求。

缓存不是 Host 校验的替代品。动作进入 Host 后仍重新获取当前 HWND，并严格比较 canonical `id/app/title`。
如果 HWND 被复用、应用变化或标题身份失效，Host 继续返回 `stale_target`。缓存未命中时保持现有行为，不从
basename、标题或模型参数猜测 Window。

### Agent 使用语义

现有 Prompt 继续要求观察后采用 `state.window`，但正确性不再依赖模型逐字复制长路径。正确链路保持为：

`list_apps → get_window → get_window_state → 使用 state.window 输入 → 显式观察验证`

历史 desktop context 只提供应用和标题提示，不能直接作为动作目标。真实 Tool Error 不得被模型当成
`null` 成功；只有工具成功结果中的 JSON `null` 才表示 OS 输入已经分派。

## 数据流

1. Agent 观察历史或 canonical Window。
2. Host 返回最新 `state.window`。
3. Sidecar 以请求中的窗口 ID 查找最近一次 Host 返回的 canonical Window，并恢复完整对象。
4. Host 重新水合 HWND 并严格验证恢复后的 `id/app/title`；身份已变化时返回 stale-target。
5. RPC client 保留错误类型和 message，Sidecar 不将其包装为成功对象。
6. 正确 Window 的动作由 Host 返回 `null`，账本推进到 `dispatched`；后续观察决定是否 verified。

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
- 先用历史短 app 观察、再用同一短 app 点击时，preflight 和 Host 实际收到最近观察返回的完整 canonical
  Window，ledger 也只记录 canonical Window。
- 未观察、未列举或已被 Host 判定身份变化的窗口不能仅凭相同数字 ID 绕过 stale-target。

### Host contract

- `get_window_state` 可返回更新后的 canonical `state.window`。
- 使用旧 `app` 的动作返回 stale-target；使用 `state.window` 的同一动作返回 `null`。

只运行涉及 Computer Use、Desktop Host client/runtime 和 Windows Host contract 的定向测试。

## 验收标准

- 复现会话中的旧 `Weixin.exe` 目标时，Agent 得到明确的 stale-target Tool Error，而不是
  `Computer Use v3 input methods must return null`。
- stale-target 不弹出动作确认，不产生 OS 输入。
- 使用观察返回的完整 canonical Window 后，`click/type_text/press_key/activate_window` 成功返回 `null`。
- 模型在同一运行期错误复用历史 `Weixin.exe` 时，Sidecar 能恢复已观察的完整 canonical Window，且 Host
  仍执行严格身份复核。
- click 的元素目标和坐标目标无法同时提交。
- 正确链路下微信输入框可被点击并输入草稿；发送仍需动作时确认和重新观察验证。

## 剩余风险

- 缓存仅存在于一次 Computer Use 工具运行期；新运行仍须先通过 `list_apps/list_windows/get_window` 或观察
  建立可信绑定。
- 并发读取可能以最后完成的 Host 结果更新同一窗口 ID；Host 的最终身份复核仍是安全边界。
- 微信 UIA 树仍只暴露自绘 pane，坐标点击仍依赖最新截图与正确 DPI 变换。
- 连接错误分类若覆盖不完整，可能把真正的 Host 断开作为普通 Tool Error 暴露；定向测试需要覆盖该边界。
- 真实微信发送结果仍需要用户环境中的端到端观察验证。
