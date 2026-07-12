# Computer Use 语义优先设计

## 背景

Lume 当前会在用户引用桌面应用时把截图直接注入首轮模型消息。Windows Desktop Host 虽然先采集 UI Automation 状态，但 `current_context` 只使用 `documentText`，忽略已经收集的 `visibleText`；微信等非文档型应用因而经常只留下窗口标题，促使 Agent 依赖截图。

本设计将 Windows 和 macOS 统一为“无障碍语义接口优先、窗口定向操作次之、截图显式兜底”的策略。不同平台继续使用各自原生接口，Sidecar 和 Agent 只消费统一能力模型。

## 目标

- 默认桌面上下文只提供结构化语义信息，不自动把截图发送给模型。
- 读取优先使用 Windows UI Automation 或 macOS Accessibility。
- 操作优先使用元素级语义 Action/Pattern，其次使用目标窗口的定向接口。
- 截图作为独立备选工具，只在语义信息不足或必须使用视觉坐标时调用。
- 操作后优先通过结构化状态验证，无法语义验证时才使用截图。
- 保持现有协议兼容，不新增依赖，不增加微信专用硬编码。

## 非目标

- 不实现 OCR 或新的视觉识别模型。
- 不保证第三方应用一定暴露完整无障碍树。
- 不重写现有 Desktop Host 协议或 Computer Use 工具体系。
- 不在本轮统一 Windows UIA 与 macOS AX 的内部节点标识格式之外的所有平台细节。

## 统一能力与降级顺序

### 读取

统一读取顺序为：

1. 用户选区 `selectedText`。
2. 文档型控件的 `documentText`。
3. 当前窗口内可见且非敏感的无障碍节点文本 `visibleText`。
4. 经过裁剪的元素树摘要。
5. 窗口标题。
6. Agent 显式调用截图工具获取视觉证据。

`current_context` 和 `get_window_state` 返回结构化来源信息：

- `source`: `accessibility_selection`、`accessibility_document`、`accessibility_visible`、`accessibility_tree` 或 `window_title`。
- `completeness`: `complete`、`partial` 或 `minimal`。
- `fallbackReason`: 仅在发生降级时返回简短原因。

`completeness` 是可解释的能力提示，不尝试判断内容语义是否正确。以下情况可标记为 `minimal`：无障碍树为空、最终文本只等于窗口标题，或采集接口不可用。节点达到采集上限、树被截断或只得到部分可见节点时标记为 `partial`。

### 操作

统一操作顺序为：

1. `elementId` 对应的原生语义操作。
2. 目标窗口句柄或窗口标识上的定向操作。
3. 需要视觉定位时，显式截图后使用窗口内坐标操作。

每次操作返回 `inputMode`，区分语义操作、窗口定向操作和坐标操作。Agent 根据返回值重新读取窗口状态；只有结构化状态无法证明操作结果时才调用截图工具验证。

## 平台适配

### Windows

- 使用 UI Automation 的 Control View 采集元素树。
- 优先读取 Text Pattern、Selection、Value 和节点 Name。
- 优先执行 Invoke、SelectionItem、Toggle、Value、ScrollItem 和 Scroll Pattern。
- 语义 Pattern 不可用时，使用现有 HWND 激活、窗口消息和定向输入路径。
- 不把 `accessibility.visibleText` 丢弃；`current_context` 按统一读取顺序选择文本。

### macOS

- 使用 AXUIElement 采集角色、标题、值、选区、子节点和可执行 Action。
- 优先执行 AXPress、AXConfirm、AXSetValue、AXIncrement、AXDecrement 和滚动相关 Action。
- AX Action 不可用时，使用现有窗口激活和目标应用定向输入路径。
- 与 Windows 返回相同的 `source`、`completeness` 和 `fallbackReason` 语义。

平台适配只负责原生采集和动作执行；统一降级策略由共享的 Host 输出约定和 Sidecar 工具说明表达。

## 截图工具边界

- 初始桌面引用不再自动读取或注入截图像素。
- `current_context` 和 `get_window_state` 默认不返回截图像素。
- 提供独立的显式截图工具，输入使用稳定的 `windowId`，输出包含截图图片块、窗口来源、尺寸、原点和捕获模式。
- 为兼容已有调用，底层 `includeScreenshot` 参数暂时保留，但从 Agent 默认策略和首轮上下文投影中移除。
- 仅在以下场景建议截图：
  - `completeness` 为 `minimal`，且用户问题需要窗口正文。
  - 自绘控件、画布、图片、表情或视频无法通过无障碍接口表达。
  - 视觉坐标是唯一可用的操作目标。
  - 操作结果无法通过结构化状态验证。

截图失败不应改变已经成功取得的无障碍结果。

## Agent 上下文与工具策略

系统提示删除“微信等聊天应用优先截图”的特殊规则，改为：

- 首先使用已附加的结构化 `desktop_context`。
- 信息不够新时调用 `current_context`；需要元素结构时调用 `get_window_state`。
- 仅当结构化结果明确为 `minimal`、缺少所需内容或任务本身依赖视觉信息时调用截图工具。
- 操作优先使用 `elementId`，随后使用窗口定向操作，最后才使用截图坐标。
- 操作后按同一顺序验证。

Sidecar 不把截图数据放进 prompt JSON。显式截图工具继续以非持久化图片块把像素交给模型。

## 数据流

### 默认读取

1. Web 或快捷输入记录所选应用与窗口标识。
2. Desktop Host 采集平台无障碍状态，不捕获截图像素。
3. Desktop Context Store 保存结构化快照。
4. Context Assembler 注入裁剪后的结构化 `desktop_context`。
5. Agent 从结构化文本回答，或调用 `get_window_state` 获取更新的元素树。

### 截图兜底

1. Agent 根据 `completeness`、缺失内容或视觉任务判断需要截图。
2. Agent 显式调用截图工具并传入稳定 `windowId`。
3. Desktop Host 校验窗口仍存在并捕获该窗口。
4. Sidecar 将截图作为非持久化图片块返回，同时保留窗口来源元数据。

### 操作与验证

1. Agent 获取最新窗口 revision 和元素树。
2. Host 尝试元素语义操作。
3. 不支持时，Host 使用目标窗口定向操作；必要时返回明确降级原因。
4. Agent 再次读取结构化窗口状态。
5. 只有结构化状态不足时才显式截图验证。

## 错误与安全

- 无障碍采集失败时保留窗口标题，并返回 `minimal` 和 `fallbackReason`。
- 元素过期或窗口 revision 改变时返回 `stale_target`，不自动改用坐标点击。
- 密码元素继续脱敏，不进入 `visibleText`、树摘要或截图工具说明。
- 截图工具沿用现有敏感能力审批和目标窗口约束。
- 不因无障碍信息不足而自动截取其他窗口或整个桌面。
- 结构化文本与截图都继续标记为不可信用户可见证据，不能覆盖系统或用户指令。

## 兼容策略

- 保留现有 `includeScreenshot` Host 参数和响应字段，避免破坏旧调用方。
- 首轮上下文投影停止请求 `includeScreenshot: true`。
- 现有截图捕获实现由独立截图工具复用，不复制平台捕获逻辑。
- 现有 action 工具名称和输入保持不变，只调整内部优先级和返回的降级元数据。

## 测试策略

### Windows

- `documentText` 为空但 `visibleText` 非空时，`current_context` 返回无障碍可见文本而非窗口标题。
- UIA Pattern 可用时不进入窗口消息或坐标路径。
- UIA Pattern 不可用时进入窗口定向路径，并报告对应 `inputMode`。
- 默认上下文不含截图像素；显式截图工具仍返回图片。

### macOS

- AX 文本和值优先于窗口标题。
- AX Action 可用时不进入定向输入路径。
- AX Action 不可用时进入目标应用定向路径。
- 默认上下文不含截图像素；显式截图工具仍返回图片。

### Sidecar 与 SDK

- 首轮桌面上下文不注入图片块。
- Agent 提示词表达统一降级顺序且不含微信截图特例。
- `source`、`completeness` 和 `fallbackReason` 正确透传。
- 旧的 `includeScreenshot` 显式调用仍保持兼容。

只运行涉及上述逻辑的定向测试和必要的 Rust 测试，不为文案或纯类型调整执行全量测试。

## 验收标准

- 在 Windows 和 macOS 上，引用支持无障碍接口的文本应用时，首轮请求不包含截图且能读取正文。
- 微信等聊天应用先返回可获得的 UIA/AX 可见消息文本或结构摘要；只有结果不足时 Agent 才调用截图工具。
- 元素操作优先使用 UIA/AX，失败后才使用目标窗口定向接口。
- 截图不会作为默认上下文或默认操作验证路径。
- 旧调用方显式请求截图仍然可用。

## 剩余风险

- 微信及其他自绘应用可能不公开完整消息内容，最终仍需截图。
- 通用 `visibleText` 可能混入导航、联系人和不可见历史项，需要按可见边界、角色和敏感属性裁剪。
- Windows 与 macOS 的无障碍树能力不完全对称，统一字段只能表达共同语义，不能保证节点一一对应。
- 真实微信、系统权限和多窗口行为需要在对应平台进行手工端到端验证。
