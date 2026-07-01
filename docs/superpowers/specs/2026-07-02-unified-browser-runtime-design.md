# Lume 统一浏览器运行时设计

## 1. 背景

Lume 当前通过 `lume-chrome` 插件把 Chrome Extension、Native Host 和
`node_repl` 串联起来。该实现已经覆盖导航、定位器、CUA、截图、下载、
文件上传、剪贴板和标签页清理等基础能力，但与 Codex Browser 的公开契约仍有
结构性差异：

- 当前 capability 对象主要提供文档，不能按 Codex 方式直接调用能力方法。
- 部分未完整实现的能力仍会出现在静态文档或公共对象上，Agent 会产生能力幻觉。
- 现有 `lumeBrowser.control.*` 是 Lume 特有 facade，与目标公共 API 不兼容。
- Node REPL 会话各自创建临时 WebSocket App Server，连接、版本和多会话路由不稳定。
- 未传入确认回调时，浏览器确认请求会默认批准，不符合安全要求。
- Lume 的内置浏览器是 renderer 内的 `<iframe>`，无法可靠控制跨域页面、CDP、
  下载、对话框或独立浏览器会话。

本设计以 Codex Browser `26.623.70822` 的公开 `api.json` 和行为文档为兼容基线。
专有实现细节、品牌资源和未公开能力不属于兼容目标。

## 2. 目标

建设一个由 `lume-chrome` 插件提供公共客户端、由 Lume Core 提供浏览器 Broker
和 IAB 后端的统一浏览器运行时：

1. 对齐 Codex Browser 的公开 API 名称、参数、返回值和行为语义。
2. 同时支持 Electron IAB 与 Chrome Extension 两个真实后端。
3. IAB 只服务本地开发目标；公网、现有 Chrome 标签页和用户登录态由 Chrome 处理。
4. 根据后端能力动态裁剪 API，并生成与当前后端一致的有效文档。
5. 通过统一安全策略处理 URL、确认、文件传输、raw CDP 和安全凭据输入。
6. 使用同一套 conformance 场景对两个真实后端建立 Windows PR 门禁。

## 3. 非目标

- 本阶段不实现独立 cloud/CDP backend，但保留 backend 类型和发现扩展点。
- 不复制 Codex 的专有源码、可执行内部实现、图标、提示词或品牌。
- 不把 Codex bundle 中标记为 `internalOnly` 的 WebMCP 作为公开兼容 API。
- IAB 不提供公网浏览、用户 Chrome profile 复用或公网登录态迁移。
- 不保留 `lumeBrowser.control.*` 或旧临时 App Server 的兼容层。
- 不引入新的第三方运行时依赖。

## 4. 仓库与所有权

该功能跨两个现有仓库交付：

### `lume-plugins`

`plugins/lume-chrome` 拥有：

- Codex 兼容的 BrowserClient 公共对象模型。
- API manifest、backend 条件、capability 定义和动态文档清单。
- backend discovery 与统一 transport 抽象。
- Chrome Extension backend、Native Host 协议适配和插件 skill。
- 可同时作用于 fake、IAB 和 Chrome 的 conformance harness。

插件市场 ID 在本次改造中仍为 `lume-chrome`，避免产生安装迁移问题；显示名改为
`Lume Browser`。未来是否迁移 ID 另行设计。

### `lume`

Lume Core 拥有：

- `BrowserBroker` 及其与 thread、turn、Node REPL 的连接。
- Electron `WebContentsView` IAB backend。
- Renderer 的 IAB 标签页界面与受限 IPC。
- 全局安全确认、secure elicitation 和响应 metadata 集成。
- IAB backend 的真实 Electron E2E。

公共客户端属于插件，Lume Core 不再定义第二套 Agent 浏览器 API。

## 5. 总体架构

```text
Agent
  -> node_repl js
  -> lume-chrome BrowserClient
  -> Lume BrowserBroker
       -> Electron IAB backend
       -> Chrome Native Host / Extension backend
```

### 5.1 BrowserClient

`setupBrowserRuntime({ globals: globalThis })` 每个 Node REPL kernel 只初始化一次，
安装稳定的 `agent` 入口。重复初始化复用现有对象，不创建新监听端口或覆盖活跃
browser bindings。

BrowserClient 只依赖统一 transport，不了解 Electron 或 Chrome 的内部实现。所有
Browser、Tab、Locator、Dialog、Download 和 Capability 对象都携带 backend
generation。generation 变化后，旧对象在本地立即报 stale object，不把调用发送给
新 backend。

### 5.2 BrowserBroker

BrowserBroker 是 Lume Core 内的长期服务，负责：

- 注册、移除和列举 backend。
- 校验协议版本、backend 元数据和 capability 声明。
- 注入 thread ID、browser session ID 和 turn ID。
- 路由命令、断线事件、响应 metadata 和安全确认。
- 管理 tab lease、请求幂等键和 backend generation。

BrowserClient 通过 Core 提供的 opaque Node REPL transport 连接 Broker。公开运行时
不暴露端口、鉴权 token 或 Electron IPC 通道。

### 5.3 Backend contract

每个 backend 在注册时返回：

- 唯一 backend ID、类型和用户可读名称。
- 协议版本和 backend generation。
- backend metadata，例如 Chrome extension instance/profile。
- browser/tab capability 列表。
- `apiSupportOverrides`。

协议主版本不兼容时拒绝注册，不能静默降级。次版本只允许向后兼容的新增字段。
公共命令使用结构化 JSON-RPC 请求、成功响应和带稳定 code 的失败响应。

## 6. Backend 选择

`agent.browsers` 提供 `get()`、`list()`、`getDefault()` 和 `getForUrl()`。

选择规则按以下优先级执行：

1. 用户明确指定 `iab` 或 `extension` 时，必须使用该 backend；不可自动替换。
2. `localhost`、IPv4 loopback、IPv6 loopback和允许的 `file://` 目标优先 IAB。
3. 公网 URL 必须选择 Chrome。
4. 需要现有 Chrome tab、profile、extension 或登录态的任务必须选择 Chrome。
5. URL 与某 backend 的现有 tab 精确匹配、同 origin/path 匹配或同 hostname
   匹配时，可优先复用该 backend。
6. 未提供 URL 时默认优先 IAB；IAB 不可用时选择 Chrome。

显式选择失败时返回 backend unavailable，并提供对应 troubleshooting 文档名称，
不退回其他浏览器控制方式。

## 7. 公共 API 兼容

API manifest 以 Codex Browser 公开 `api.json` 为基线，至少包括：

- `Agent.browsers`、`Agent.documentation`
- `Browsers.get/list/getDefault/getForUrl`
- `Browser.browserId/capabilities/tabs/user/documentation/nameSession`
- `BrowserUser.openTabs/claimTab/history`
- `Tabs.new/get/list/selected/finalize/content`
- `Tab.capabilities/clipboard/content/cua/dev/dom_cua/playwright`
- Tab 导航、截图、dialog、deliverable 和 handoff 方法
- Playwright page、frame、locator、download 和 file chooser 子集
- DOM CUA、坐标 CUA、clipboard 和 developer logs

方法的参数名、返回结构和 unsupported-by-default 规则与基线一致。Lume 当前额外的
书签、reading list、recent sessions、site permission 管理和高层搜索 facade 不再
进入 Agent 公共对象。

### 7.1 动态 API 裁剪

BrowserClient 使用 Proxy 按 backend type、manifest 默认值和
`apiSupportOverrides` 隐藏不支持成员。隐藏后的方法不能通过属性读取、`in`、
`ownKeys` 或 descriptor 侧信道被误认为可用。

规则是：能力完整工作才暴露。部分实现、reference-only 命令或仅存在 dispatcher
分支的功能均不得广告。

### 7.2 Capability

公开 browser capability：

- `viewport`
- `visibility`

公开 tab capability：

- `pageAssets`
- `cdp`
- `browserAuth`
- `botDetection`

`capabilities.get(id)` 返回带实际方法的 capability 对象，而不是只有
`documentation()` 的通用占位对象。能力是否出现由 backend 注册信息决定。

WebMCP 保持内部实验能力，默认不出现在 API manifest、capability list 或 skill
文档中。若未来公开，必须单独评审安全和标准稳定性。

## 8. 动态文档

插件维护：

- 核心 API manifest。
- backend 条件文档清单。
- capability 独立文档。
- setup、troubleshooting、confirmation、upload 和 screenshot 等按需文档。

`browser.documentation()` 一次返回当前 backend 的完整有效 API 与必读行为文档。
不可用成员和不满足条件的文档不进入输出。`agent.documentation.get(name)` 和
`browser.documentation.get(name)` 只读取白名单内的无扩展名相对路径。

skill 要求 Agent：初始化一次、持久复用 browser/tab bindings、先读取有效文档、
从最新页面状态构建 locator，并在结束前 finalize。

## 9. Electron IAB backend

### 9.1 WebContentsView

删除主标签页和右侧面板中的浏览器 `<iframe>`。每个 IAB tab 由 Electron 主进程
创建一个 `WebContentsView`，Renderer 只保存逻辑 tab ID 和 UI 状态。

Renderer 通过白名单 IPC 发送：

- 创建、选择、关闭 tab。
- 地址栏导航、后退、前进、刷新。
- 当前容器 bounds、可见性和焦点。

主进程根据 bounds 挂载或隐藏 view。页面 webContents 不获得 preload、Node.js、
Lume renderer IPC 或主窗口权限。

### 9.2 Session

IAB 使用独立持久化 Electron partition，允许本地开发应用的 cookie、localStorage
和 IndexedDB 在 Lume 重启后继续存在，但不与主窗口或 Chrome profile 共享。

Browser session 与 Electron partition 分离。session/turn 只管理控制权、临时 tab
和交付状态，不清空用户的本地站点数据。

### 9.3 本地 URL policy

允许：

- `http://localhost` 与 `https://localhost`
- `127.0.0.0/8`
- `[::1]`
- 解析后位于当前工作区根目录内的 `file://`

不允许：

- 公网 hostname、局域网 IP、非 HTTP(S)/受控 file scheme
- 从允许页面重定向到不允许目标
- popup、window.open、iframe 或下载触发的策略绕过

主进程执行最终校验，Renderer 和 BrowserClient 的预检只用于尽早反馈。

### 9.4 自动化能力

IAB 通过 Electron `webContents.debugger` 提供 CDP 基础设施，并在 backend 内实现：

- 跨进程 iframe 自动附加与 frame/session 路由。
- DOM snapshot、locator、只读 evaluate 和 actionability。
- CUA、DOM CUA、截图、dialog、下载、文件选择器和 console logs。
- Page assets、clipboard 和受控 raw CDP capability。

同一 tab 的有副作用命令串行执行。互不依赖的只读命令可受控并发，但不得观察到
跨导航的混合状态。

## 10. Chrome backend

Chrome Extension 与 Native Host 改为向长期 BrowserBroker 注册，不再连接每个
Node REPL kernel 创建的临时 App Server。

backend 必须提供：

- extension/native/protocol/build 版本握手。
- extension instance、profile 和 window metadata。
- 用户 tab 与 Agent 创建 tab 的来源标记。
- OOPIF target/session 管理、dialog、download/file chooser 和 CDP event buffer。
- backend generation 和断线通知。

Browser session 只认领一次用户标签页。重复请求使用 request ID 去重，避免连接
恢复时重复创建 tab 或 tab group。

`finalize({ keep })` 的行为：

- 未保留的 Agent 创建中间 tab 关闭。
- 未保留的用户 tab 只释放控制权，不关闭。
- deliverable tab 释放控制权并保持打开。
- handoff tab 保持现场，供后续 turn 重新认领。
- finalize 是该 turn 最后一个 browser 动作。

## 11. Playwright 与页面交互

只实现 manifest 声明的 Playwright 子集，不宣称兼容完整 upstream Playwright。

关键语义：

- locator 默认 strict；动作前执行 attached、visible、enabled 和必要的 editable
  检查。
- `and/or/filter/has/hasNot` 必须递归解析完整 locator AST。
- frame locator 必须支持同源 frame 和跨进程 OOPIF。
- navigation、strict violation、selector parse error 或 context destroyed 具有稳定错误码。
- `evaluate` 运行在只读页面 scope，禁止模块加载和写入页面状态的辅助能力。
- JS dialog 存在时阻止其他页面动作，直到通过 `getJsDialog()` 处理。
- navigation 后旧 DOM node ID、element handle 语义和 file chooser 必须失效。

`elementInfo({x,y})` 和 `elementScreenshot({x,y})` 以截图坐标返回或标记候选元素，
用于视觉结果到稳定 locator 的过渡。

## 12. 安全模型

### 12.1 默认拒绝

所有安全决策由 BrowserBroker 的统一策略层执行。未连接 Lume 确认 UI 或无法持久化
决策时默认拒绝，不允许自动批准。

需要按操作时点确认的动作包括：

- 新 origin 访问和受限制页面权限。
- 文件上传、下载和 page asset 落盘。
- clipboard 写入。
- raw CDP 和跨 origin asset 获取。
- 提交表单、发送消息、删除、购买、权限变更等外部副作用。

网页、截图、下载内容和 tool output 均视为不可信内容，不能授予权限或覆盖用户意图。

### 12.2 Browser auth

`browserAuth` 只在 Node REPL secure elicitation 和 backend 安全填充均可用时暴露。

Broker 在显示安全表单前校验：

- canonical origin 和短期过期时间。
- 当前 main frame、loader 和 frame identity。
- 每个字段 locator 唯一、可见、启用、可编辑且 input type 匹配。
- 字段与 submit locator 指向不同元素。

凭据从 Lume 安全表单直接传入 backend，BrowserClient、Agent、Node REPL 输出、日志
和 telemetry 永远不能读取字段值。结果只返回公开状态：`submitted`、`declined`、
`cancelled`、`unavailable`、`expired`、`origin_changed`、`page_changed`、
`locator_invalid` 或 `submission_failed`。

CAPTCHA 不属于 browserAuth。是否处理 CAPTCHA 必须单独获得用户确认。

## 13. 错误与恢复

公共错误至少包含：

- backend unavailable
- protocol mismatch
- stale browser object
- unsupported capability/member
- navigation blocked
- user denied
- strict locator violation
- timeout
- page execution failed
- browser control interrupted

错误包含稳定 code 和 recoverable 标记。消息不得泄露 token、凭据、内部 pipe 名称或
不必要的本机路径。

恢复规则：

- backend 断线后重新 discovery，并重新获取 browser、tab、locator 和 capability。
- 有副作用命令不自动重放。
- 幂等读取在确认 backend generation 未变化时最多自动重试一次。
- 启动连接检查最多等待后重试一次，不循环探测。
- stale locator 或 strict violation 必须重新观察页面后构建新 locator。
- 明确 backend 选择不能通过切换其他 backend 掩盖失败。

## 14. Response metadata

每次 browser command 尽力通过 `nodeRepl.setResponseMeta()` 附加：

- browser-use 标记和 backend type。
- browser ID 和当前 URL。
- 当前 session 控制的 tab IDs。
- 与动作相关的当前截图。
- finalize 后的 `sessionEnded`。

metadata 生成失败不得覆盖原命令结果，但必须进入结构化诊断日志。截图只选择当前或
动作目标 tab，不能因 metadata 生成额外标签页。

## 15. 测试设计

### 15.1 Conformance fixture

插件仓库维护一个无外网依赖的本地 fixture server 和共享场景集，覆盖：

- backend discovery、选择、动态 API 和动态文档。
- tab new/get/claim/list/selected/finalize。
- navigation、history、load state、popup 和 dialog。
- locator 组合、strict mode、同源 frame 和 OOPIF。
- DOM CUA、坐标 CUA、截图与坐标元素反查。
- download、upload、clipboard、content export 和 page assets。
- CDP command/events、console logs 和 capability 文档。
- confirmation、browserAuth、URL policy 和敏感数据不泄露。
- 断线、generation 变化、stale object 和幂等去重。

同一场景定义必须可运行于 fake backend、Electron IAB 和 Chrome backend。backend
明确不支持的成员必须在有效 API 中消失，而不是把运行期 `not implemented` 当通过。

### 15.2 测试层级

1. 纯契约测试：所有平台运行，校验 manifest、schema、capability 和 dispatcher
   覆盖。
2. IAB E2E：启动真实 Electron `WebContentsView` 和 fixture server。
3. Chrome E2E：Windows Runner 使用独立 Chrome profile、unpacked extension 和临时
   Native Host manifest。

每个 PR 强制运行 Windows IAB 与 Chrome 真实 E2E，同时保留跨平台纯契约测试。
真实 E2E 只允许启动握手重试一次，不允许用测试级宽泛 retry 掩盖竞态。

失败 artifact 包含 Broker 日志、backend generation、extension service-worker 日志、
截图、tab/session 清单和失败场景名称，不包含凭据或剪贴板敏感正文。

### 15.3 跨仓库验证

插件仓库是公共 contract 与 conformance harness 的事实来源。两个仓库的 CI 都记录
并检出对方的兼容 revision：

- 插件 PR 使用目标 Lume revision 验证 Chrome 与客户端变化。
- Lume PR 使用目标插件 revision 验证 Broker 与 IAB 变化。

协议变更必须保持至少一个过渡版本的向后兼容，避免协调 PR 因循环依赖无法合入。

## 16. 实施阶段

### 阶段一：契约与客户端

- 建立 API manifest、capability definitions 和文档清单。
- 重写 BrowserClient 的动态 API 裁剪与 stale generation 机制。
- 建立 fake backend 和 conformance harness。

### 阶段二：Broker 与 IAB

- 建立 BrowserBroker 和 Node REPL opaque transport。
- 实现 WebContentsView IAB backend 和 renderer IPC。
- 迁移两个 iframe 浏览器入口并删除 iframe 实现。

### 阶段三：Chrome 对齐

- Native Host/Extension 注册到 Broker。
- 补齐 OOPIF、dialog、locator composition、element info 和公开 capability。
- 实现稳定版本握手、断线和幂等语义。

### 阶段四：安全与 metadata

- 接入统一确认策略和默认拒绝。
- 实现 secure browserAuth。
- 补齐 response metadata、动态 troubleshooting 和安全日志。

### 阶段五：真实 CI 与清理

- 建立 Windows 双后端真实 E2E 门禁。
- 删除临时 App Server、`lumeBrowser.control.*`、旧静态矩阵和 reference-only 公开项。
- 更新插件包、市场元数据和安装诊断。

每个阶段必须保持协议可验证，不能在 capability list 中提前广告后续阶段能力。

## 17. 完成条件

全部满足时才算完成：

1. Codex 公开 API 成员要么在对应真实 backend 上通过 conformance，要么不出现在该
   backend 的有效 API 中。
2. `getForUrl()` 按规则选择本地 IAB 和公网 Chrome，并尊重明确选择。
3. IAB 不再使用 iframe，公网导航和工作区外 file URL 在主进程被阻止。
4. Chrome 重连不会重复创建 tab 或 tab group。
5. OOPIF、dialog、download、upload、clipboard、page assets 和 locator composition
   在广告支持的 backend 上通过真实 E2E。
6. browserAuth 凭据不可被 Agent、BrowserClient、Node REPL 输出或日志观察。
7. 未连接确认 UI 时，风险动作默认拒绝。
8. finalize 正确区分 Agent tab、用户 tab、deliverable 和 handoff。
9. Windows PR 门禁同时通过 Electron IAB 与真实 Chrome 扩展 E2E。
10. 旧 facade、临时 App Server 和 iframe 浏览器代码已删除。

## 18. 主要风险

- Electron `WebContentsView` 生命周期与 React 布局同步可能产生悬空 view 或遮挡；
  必须由主进程单一所有者管理并在窗口/tab 销毁时清理。
- Chrome MV3 service worker 会休眠；Broker generation 和握手必须把恢复视为新连接，
  不能继续使用旧对象。
- 跨仓库协议容易漂移；manifest、版本握手和共享 conformance 是合入门禁，而不是
  文档约定。
- Windows Runner 的 Chrome extension 启动可能受版本策略影响；CI 必须固定可诊断
  的启动参数和独立 profile，并保留失败 artifact。
- 公共 API 精确对齐会删除当前 Lume 特有调用方式；本次决策明确接受该破坏性变化，
  不提供 facade 兼容层。
