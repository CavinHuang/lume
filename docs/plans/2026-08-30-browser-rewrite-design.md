# 浏览器核心重写设计 —— 按 ZCode 蓝图 1:1

> 决策:四端全删现有浏览器实现(desktop/web/sidecar/shared),按 ZCode IAB 蓝图重新实现;批注子系统随核心删除;新核心采用 ZCode 命令协议。
> 施工蓝图:`D:\workspace\projects\ai-projects\lume\.zcode\analysis\extracted\`(ZCode 还原源码 15.5k 行)+ `runtime-exact/`(字节精确注入脚本)+ 架构报告三件套。
> 传输层不变:sidecar↔main 仍走 Lume 的 postMessage + HMAC MAC 桥(应用骨架),仅载荷换 ZCode 命令协议。

## 1. 目标形态(与 ZCode 的映射)

| ZCode 构件(还原源码) | Lume 新模块 | 移植方式 |
|---|---|---|
| BrowserGuestManager(01,2834 行) | `apps/desktop/src/browser/core/guest-manager.ts` | 结构化移植:tab 注册表/五元组 scope/attachGuest 校验链/46 命令 execute/录制/下载/对话框跟踪 |
| BrowserTabResidencyCoordinator(07 清洁版) | `browser/core/residency.ts` | 近乎直移(纯逻辑,已有清洁版) |
| DesktopBrowserScreenshotSurfaceCoordinator + ActivityController(03) | `browser/core/screenshot-surface.ts` | 直移(prepare/ready/release + 透明窗口引导 + capture pump) |
| executeBrowserCommandOnView + playwright-over-CDP(02,3064 行) | `browser/core/executor/`(dispatcher + locator-session + dom-snapshot-session + evaluate 通道) | 直移;注入脚本源读 Lume 自带 playwright-core 同款路径 |
| CUA 输入原语(08 清洁版) | `browser/core/input.ts` | 直移 |
| 注入脚本(runtime-exact,字节精确) | `browser/core/injected/*.ts` | 六个生成函数 + Fj + ple/IH 逐字移植为 TS 模板;playwright injectedScript 运行时从 node_modules 解码(同 ZCode Fg) |
| recordBrowserVideo + WebM 录像器(05) | `browser/core/recording/` | 直移(setDisplayMediaRequestHandler + MediaRecorder VP8) |
| EmbeddedBrowserJavaScriptDialogController(06) | `browser/core/dialog-controller.ts` | 直移(原生对话框 + 自动化代答) |
| registerBrowserViewIpcHandlers + 装配(06) | `browser/ipc.ts` | 频道名保持 `lume:browser-view-*` 前缀,载荷形状按 ZCode |
| 恢复停靠协议 | `browser/core/restore-protocol.ts` | `lume-browser-restore://pending` 延迟空 HTML |
| renderer 面板(池/摆位/工具栏,04 的语义) | `apps/web/src/components/browser/`(新 SidePane) | 按 ZCode 面板语义重写:tab 模型/attach/residency 上报/屏外定影/操作事件;webview 池可沿用现池的定位思路但按 ZCode present 语义简化 |
| guest preload | `browser/guest-preload.cjs` | 精简版:alert/confirm 劫持 + wheel 边界转发(无 annotation/webmcp) |
| sidecar IAB backend | `apps/sidecar/src/services/browser/iab-backend.ts` | ZCode 形状(id:"iab:<uuid>"/generation/capabilities/apiSupportOverrides),execute 走既有 MAC RPC 到 main |
| browser-use 插件门面/skill | `bundled-plugins/browser/` | SKILL.md 移植 ZCode control-browser(改 Lume 通道名);门面 SDK 简化版(Tab.playwright/cua/recording → 46 命令) |

## 2. 协议设计

### 2.1 命令面(共享包 `packages/shared/src/browser/`)

- `protocol.ts`:46 个 method 的 discriminatedUnion zod(navigate/back/forward/reload/getState/snapshot/screenshot/click/fill/type/press/scroll/hover/select/check/drag/cuaKeypress/cuaScroll/cuaDrag/domCuaScroll/elementInfo/evaluate/waitForURL/waitForLoadState/getDialog/handleDialog/playwright/playwrightWaitForTimeout/activateTab/newTab/claimTab/listUserTabs/finalize/finalizeTabs/markDeliverable/markHandoff/close/nameSession/list/capabilities/browserVisibility*/browserViewport*/recordingStart/Status/Cancel/cancelRequest/turnEnded/closeSession);请求上下文 `{requestId, sessionId, turnId?, workspaceKey, clientMode:"desktop-continuous"}`;响应 meta `{browserUse:true, backendType:"iab", browserId, browserGeneration, openTabIds, tabId?, currentUrl?, lifecycle?}`。
- `constants.ts`:分区 `persist:lume-browser`;viewport 320×320~3840×2160;`BROWSER_PROTOCOL_VERSION = 1`(新协议,新起点;Lume 旧 v9 常量随旧类型删除);事件频道名表。
- `errors.ts`:ZCode 错误码集(duplicate_request_id/navigation_blocked/timeout/execution_error/cancelled/capability_unsupported/backend_unavailable)+ sideEffect 语义;`incompatible_protocol` 闸沿用。
- `capabilities.ts`:唯一 capability `visibility`;`unsupportedByDefaultIn` 矩阵 + overrides(claimTab/finalize/markDeliverable/markHandoff/recording.* 强制开)。

### 2.2 事件面(main→renderer,`lume:browser-view-*`)

ready/operation/visibility/viewport-changed/screenshot-surface-prepare|ready|release/close-tab/suspend/restore —— 载荷形状按 ZCode(含 browserGeneration/residencyGeneration);renderer→main invoke:attach-guest/detach-guest/close-tab-from-renderer/report-residency/suspend-ready/ensure-resident/restore-tabs/update-viewport + screenshot-surface-ready(send)。

### 2.3 安全模型(保留 Lume 增强项)

- webview 挂载:will-attach 强制 sandbox/contextIsolation/专属 guest preload/协议白名单(about:/data:/http:/https:/lume-browser-restore:)——**保留 Lume 的 mountToken 签发**(比 ZCode 裸 bootstrap URL 更严),但 attach 载荷对齐 ZCode 形状(tabId+webContentsId+active+residencyGeneration)。
- setWindowOpenHandler 一律 deny → Ctrl/Cmd 外开 / 其余回 renderer 开新 tab。
- MAC+sequence 桥不变;`incompatible_protocol` 闸保留(协议 v1 起)。

### 2.4 不做的事(重写范围外)

- 批注/评论/设计变更、WebMCP、extension 后端、Chrome 数据导入(首版不含;导入可后置为独立 PR)、advancedCdp 用户 CDP 通道、connection-vault/凭据填充、`browserAuth` 弹窗链。
- weread webview 与 office/local-file 预览是独立功能,保留现状(仅解除对 browser runtime 的引用)。

## 3. 实施阶段(每阶段一个可 review 提交)

- **R1 删除**:按盘点清单四端删除;保留下载/凭据/审计/网络守卫等可复用模块原样(不接新核心,待后续按需);剩余应用 typecheck + 非浏览器测试全绿。
- **R2 shared 协议包**:protocol/constants/errors/capabilities + zod;单测。
- **R3 desktop 核心**:residency → guest-manager → executor/input/injected → screenshot-surface → dialog → recording → ipc + guest-preload;逐模块单测(纯逻辑部分)。
- **R4 renderer 面板**:SidePane + 池 + 工具栏 + 摆位。
- **R5 sidecar 后端 + skill**:iab-backend(MAC 桥载荷换 ZCode 命令)+ 门面 + control-browser SKILL。
- **R6 端到端**:browser:e2e 重写冒烟(开 tab→导航→快照→截图→挂起→恢复→录像)。

## 4. 风险与回退

- 分支策略:全部在 `feat/browser-zcode-alignment` 上继续,删除与重写各自成提交;旧实现完整存在于 git 历史,回退即 revert。
- 旧 7 提交中:C1(测试发现)全仓受益保留;C6 闸思路在新协议上重实现;D1/D2 与驻留机随旧实现删除(历史保留)。
- 功能真空期:删除与重写完成之间,browser 面板不可用(分支内可接受,不合入 main)。
