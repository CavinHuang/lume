# Plan: 重新设计托盘与 Lume 窗口行为
_Locked via grill — by Codex + user_

## Goal
在保留“显示托盘”“最小化到托盘”“关闭到托盘”三个独立设置的前提下，让 Windows 与 macOS 的窗口生命周期可预测、设置组合始终有效，并将托盘重做为紧凑的原生入口：使用平台专用单色图标、统一中文菜单、提供新建对话与最近 5 条主会话直达，同时修复主窗口销毁后托盘无法恢复窗口等现有断裂状态。

## Approach
1. 将窗口行为收敛为可测试的策略函数，输入平台、事件类型、托盘可用性、退出状态和三个设置，输出 `native-minimize`、`hide-to-tray`、`close-window` 或 `quit-app`；主进程只执行策略结果。
   - Windows：开启对应托盘设置时隐藏；关闭“最小化到托盘”时原生最小化；关闭“关闭到托盘”时退出整个应用。
   - macOS：开启对应托盘设置时隐藏；否则最小化使用 Dock 原生行为，关闭只销毁主窗口但保留应用；通过 Dock 激活或托盘入口重新创建主窗口。
   - 托盘不可用（未启用、创建失败或已销毁）时禁止 `hide-to-tray`：Windows 最小化退回原生任务栏、关闭退回退出应用；macOS 最小化退回 Dock、关闭退回只关闭窗口。
   - `isQuitting` 始终绕过关闭拦截，确保 `app.quit()`、`Cmd+Q` 与更新安装不会被隐藏逻辑阻止。Windows 从窗口关闭触发退出时先 `preventDefault()`，原子设置 `isQuitting=true`，再排入 microtask 调用一次 `app.quit()`，避免 close 重入；其他窗口沿用退出中直通规则。
2. 在设置持久化边界维护配置不变量：关闭 `showTray` 时，同一次保存把 `minimizeToTray` 和 `closeToTray` 一并设为 `false`。补齐 RPC schema 对 `showTray` 的支持，让 sidecar 持久值、renderer 乐观状态和主进程运行时状态收到同一个规范化结果；设置 UI 仍使用现有三个全局 Switch，不引入新控件或依赖。窗口行为同步携带 renderer 单调递增的 `revision`，主进程按 `{ mainWindowGeneration, revision }` 接受更新：新 generation 成为 authoritative 时重置已接受 revision，同一 generation 内仅接受更大值，避免旧响应覆盖新运行时状态或窗口重建后永久拒绝更新。该 revision 不扩展为全局设置版本系统，重启仍以 sidecar 持久值为准。
3. 重构主窗口的“确保存在并显示”路径：把创建、等待 renderer 可用、恢复、显示和聚焦统一到一个入口。用共享 `mainWindowCreationPromise` 串行化并发创建，并给每个窗口实例分配 generation；`ready-to-show`、`did-finish-load`、`closed` 和待投递动作都校验 generation，旧窗口的晚到事件不得影响新窗口。等待 ready 设置明确超时，失败时清理对应 generation 并记录日志。
   - Windows 托盘左键单击只调用显示/聚焦入口，右键打开菜单；不再用焦点状态切换隐藏。
   - macOS 保持原生菜单栏习惯：单击托盘图标打开菜单，不承诺单击直接显示窗口；菜单中的“打开 Lume”负责显示。继续使用 `setContextMenu()`，不实现手工 `popUpContextMenu()`。
   - `did-finish-load`/`ready-to-show` 只代表 Electron 页面状态，不视为业务 listener 可用。renderer 在 React 导航监听器注册完成后通过仅限当前主窗口 sender 的 IPC 发送 generation-specific `renderer-ready` 握手；主进程只在该握手后投递导航。
   - 启动/重建期间的导航使用一个 generation-bound、last-intent-wins 待处理槽，而不是无界 FIFO：`open-thread`、`new-thread`、`open-settings` 都是互斥导航意图，后一次用户操作替换前一次；当前 generation 完成 renderer-ready 握手后至多投递一次并清空。窗口销毁只清理属于该 generation 的槽，旧 generation 握手或事件不得重放。
4. 将托盘菜单数据改为显式状态模型，包含主窗口状态、当前会话 ID 和最近会话列表。菜单按以下顺序构建：
   1. `打开 Lume` / `隐藏 Lume`
   2. `新建对话`、`快速输入`
   3. 禁用分组标题 `最近对话`，随后最多 5 条会话；空列表显示禁用的 `暂无最近对话`
   4. `打开设置`、`检查更新`
   5. `退出 Lume`
5. 最近会话由 renderer 已有 `agent:list-threads` 结果派生：只保留未归档、未删除且没有 `parentThreadId` 的主会话，按 `updatedAt` 降序取 5 条，不按置顶重排。renderer 在初次加载以及会话标题、归档、删除、活动时间或当前标签变化时，把最小化后的 `{ id, title, updatedAt }[]` 与当前会话 ID 同步给主进程；主进程仅保存在内存，不新增持久化副本。
   - 新同步命令必须要求 `event.sender === mainWindow.webContents`，不能只复用包含快速输入窗口的 `getTrustedWindows()`；sender 与当前 main window generation 都要匹配。
   - payload schema 严格限制为最多 5 个唯一会话 ID，ID、可选当前会话 ID 与标题设合理长度上限，`updatedAt` 必须是有限非负数，并限制序列化总字节数。当前会话可以不在最近 5 条中；只有恰好命中列表项时才显示 checked。无效数据拒绝且记录限流 warning。
   - renderer 只在菜单可见状态签名（ID、截断后标题、顺序、当前项）变化时同步；主进程以 100ms trailing coalescing 合并菜单重建，避免消息活动期间频繁刷新原生菜单。
6. 最近会话标题用按显示宽度计数的现有/小型纯函数截断：中日韩全角字符计 2、常见半角字符计 1，以约 14 个中文字符（28 个半角显示列）为上限，超出追加省略号。当前打开的会话使用原生 checked 菜单状态。点击会话时先确保主窗口存在并显示，再发送带 `threadId` 的导航动作；renderer 复用现有 `openThread`/tab 状态路径。
   - `open-thread` 处理返回确认：成功时更新当前项；ID 已不存在时不创建幽灵标签，执行一次权威 `agent:list-threads` 刷新并强制回传新托盘快照，从而移除陈旧菜单项。
7. 保持原生 `Menu`，不实现自绘托盘弹窗。新增专用小尺寸单色托盘资产：Windows 提供适合 16/20/24/32px 与高 DPI 的 `.ico` 多尺寸资源；macOS 使用简化 Lume 轮廓的 Template Image（覆盖 16/18/22px 需求并自动适配明暗菜单栏）。窗口/安装包图标继续使用现有应用图标，托盘不增加状态色、徽标或动画。
8. 为生命周期失败分支增加现有 logging service 风格的结构化事件：托盘创建失败、主窗口创建/ready 超时、旧 generation 事件丢弃、导航意图被后继意图替换、无效/非主 renderer 同步、导航目标失效。所有异步托盘动作统一捕获并记录错误；高频拒绝日志做限流，避免损坏 renderer 造成日志洪泛。
9. 仅更新与该行为直接相关的保护：
   - `desktop-core` 单元测试覆盖 Windows/macOS 的最小化、关闭、退出中、托盘不可用与配置不变量。
   - 托盘菜单测试覆盖排序/筛选后的 0、1、5、超过 5 条状态、当前项 checked、14 中文字符视觉宽度截断和中英文混排。
   - renderer 状态测试覆盖最近主会话派生及托盘 `open-thread` 导航复用。
   - 安全测试覆盖新增 IPC/desktop action 的 allowlist、严格 payload schema、主窗口 sender 校验以及快速输入 sender 被拒绝。
   - 生命周期测试覆盖并发 ensure 只创建一个窗口、窗口 ready 前被关闭、连续导航 last-intent-wins、业务 renderer-ready 握手前不投递/握手后投递、旧 generation 的晚到 ready 被忽略、窗口重建后 renderer revision 从零开始仍可同步、Windows 退出重入和托盘创建失败降级。
   - 不为图标观感或纯文案运行全量测试；在 Windows 和 macOS 分别手工验证托盘清晰度、菜单宽度、缩放/暗色模式以及完整窗口矩阵。

## Key decisions & tradeoffs
- 保留三个独立设置，而不是合并成窗口行为模式；代价是必须在持久化边界强制 `showTray=false` 时清空两个依赖设置。
- Windows 托盘单击只显示并聚焦，不做焦点敏感的显示/隐藏切换；macOS 单击按原生习惯打开菜单。隐藏行为改为显式菜单项。
- Windows 的关闭按钮在 `closeToTray=false` 时真正退出；macOS 保持原生“关闭窗口但应用仍运行”，因此必须可靠支持窗口重建。
- 最近 5 条按真实活动时间排序，排除归档、删除和子代理会话，置顶不改变顺序。
- 使用操作系统原生菜单并通过标题截断间接控制宽度；放弃固定像素宽度与完全自定义视觉，以避免多屏、缩放、失焦和跨平台定位复杂度。
- 最近会话数据由 renderer 同步到主进程内存，不让主进程另建 sidecar 数据订阅或持久缓存；严格限定只有当前主窗口可同步。启动早期允许显示“暂无最近对话”，renderer 加载后立即刷新。
- 启动期多个导航采用 last-intent-wins，不排队执行已被更新意图取代的中间页面切换。
- Windows 与 macOS 是验收平台；Linux 只保持 Electron 当前的尽力而为行为。

## Risks / open questions
- 原生菜单无法保证固定像素宽度；14 个中文字符的显示宽度上限只能约束最长内容，最终宽度仍由不同系统字体和菜单边距决定。
- Windows 与 macOS 的托盘资产需要在真实设备、不同 DPI 和菜单栏主题下人工确认，小尺寸轮廓可能需要一次视觉微调。
- renderer 到主进程的最近会话同步存在短暂陈旧窗口；点击处理通过失败确认、权威刷新和强制回传闭环移除不存在的 ID。
- 仓库当前有大量与本任务无关的未提交修改，实施时必须逐文件确认重叠，尤其是已修改的 `apps/desktop/src/main.ts`、`preload.ts`、`electron-security.ts`、RPC schema 与 web tab 状态文件。

## Out of scope
- 自绘托盘弹窗、固定像素菜单宽度、托盘动画、未读徽标或运行状态色。
- 新增“启动时隐藏”“登录时启动”等第四个窗口设置。
- 改变快速输入窗口、微信读书窗口、Action HUD 等辅助窗口的既有生命周期，除非主窗口退出清理必需。
- Linux 桌面环境专项适配。
- 提交代码、安装新依赖或清理无关代码。
