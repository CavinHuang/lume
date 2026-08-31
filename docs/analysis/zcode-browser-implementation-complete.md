# ZCode 浏览器（In-App Browser）完整实现图谱

> 本文是 ZCode Desktop v3.10.1（Electron 41）内嵌浏览器逆向分析的**单源汇总**：
> 架构、设计决策、完整实现流程、双侧代码位置（ZCode 混淆产物 ↔ 提取源 ↔ Lume 对齐实现）。
> 分析产物与字节级提取源位于主仓 `.zcode/analysis/extracted/`（01~09 + injected-scripts）；
> 逐面板报告见本目录 P1~P4 与 sidepane-round2/3。
> Lume 对齐实现全部落在 PR #860（`feat/browser-zcode-alignment`，36+ 提交），含三层验证
> （静态审计 / 运行时 e2e / 实包产物字节级比对）。

---

## 1. 进程架构总览

```
┌─ Renderer（styles-C2WGZ-SY.js，4.6MB）───────────────────────────┐
│ SidePane 控制器 Qde（tab 模型/揭示模型/最近关闭环）                 │
│ webview 池（persist:zcode-embedded-browser 分区）                  │
│ 截图摆位 staging（position:fixed + opacity:.001 离屏定影）          │
│ xterm.js 终端（CTt）+ Git 面板 + 白板（On store）                   │
└──────────────┬───────────────────────────────────────────────────┘
               │ IPC（contextBridge + 白名单；webview sendToHost）
┌──────────────▼─ Main（out/main/index.js）─────────────────────────┐
│ BrowserGuestManager —— 唯一状态权威（tab 注册表/46 命令 execute）    │
│ webContents.debugger → CDP 1.3（自动化/截图/输入）                  │
│ BrowserTabResidencyCoordinator（Gg，按 windowId，LRU 32 tab）       │
│ MAC+sequence 命令桥（sidecar 命令防伪）+ 恢复存储（JSON）            │
└──────────────┬───────────────────────────────────────────────────┘
               │ fork RPC + 通知（browser-execute MAC 桥 / terminal:*)
┌──────────────▼─ Sidecar + Host（utilityProcess）──────────────────┐
│ Sidecar：browser-use 插件门面（模型侧工具目录 → 命令透传）            │
│ Host：node-pty 终端服务 + gitService（18 方法，spawn git CLI）       │
└───────────────────────────────────────────────────────────────────┘
```

**职责边界**：浏览器权威全部在 main（ZCode 的 host 进程只有终端/git/wiki，无浏览器代码）；
renderer 只持有「展示层 tab 列表」——tab 的 WebContents 驻留预算、CDP 会话、命令裁决全在 main。

---

## 2. 核心设计决策（10 项，附证据）

| # | 决策 | 证据/理由 |
|---|------|-----------|
| 1 | **`<webview>` 而非 BrowserView** | 36 项审计确认：guest manager 硬拒 `getType()!=="webview"`；依赖 `sendToHost`（webview 独有 API）；主窗口 `webviewTag:true` |
| 2 | **main 是唯一状态权威** | renderer 的 tab 列表是展示缓存；close/claim/suspend 全部 main 裁决（失败即中止）；多窗口下按 `windowId` 分组驻留 |
| 3 | **驻留状态机**（live-visible/live-background/suspend-pending/restoring/suspended） | generation 守卫转换；保护谓词（可见/激活/截图中不驱逐）；LRU 32 tab/窗口；挂起 = 卸 webview 留空壳 ack |
| 4 | **截图三阶摆位协议**（prepare→ready→release） | renderer 把目标 webview 离屏定影（fixed + opacity:.001），main 才能捕获非激活 tab；透明窗口引导（setOpacity(0)+showInactive）供全窗捕获 |
| 5 | **录制走 setDisplayMediaRequestHandler** | 返回 `{video: guest.mainFrame}` → 隐藏 BrowserWindow canvas `setInterval(1000/fps)` 重绘 → `captureStream(fps)` → MediaRecorder VP8；90s 硬上限；动作 DSL 数据化 |
| 6 | **自动化 = playwright-over-CDP** | `webContents.debugger` CDP 1.3；隔离世界 `zcode-playwright-locator`；帧链（describeNode→quads→attachToTarget flatten）；actionability 探测（scrollIntoView 轮换 + rAF 稳定 + expectHitTarget）；注入脚本取自 playwright-core 1.59 的 `injectedScriptSource.js`（1.60+ 上游已移除，Lume 钉 1.59.1） |
| 7 | **能力模型** | `unsupportedByDefaultIn` + `requiresCapabilities` + `apiSupportOverrides` 短路——同一执行体按调用方（agent/user）与形态（desktop/remote）收窄 |
| 8 | **命令防伪 = MAC+sequence** | sidecar→main 的 browser-execute 带 HMAC 与序号（防伪造/防重放）；错误码稳定集（timeout/cancelled/navigation_blocked/duplicate_request_id/capability_unsupported/…） |
| 9 | **导航白名单** | 仅 `http:`/`https:`/精确 `about:blank`；`file:`/`data:`/`javascript:` 拒绝（`navigation_blocked`） |
| 10 | **子代理硬拒绝** | browser 工具注册即拒绝 subagent 调用（主代理亲历原则，技能文档明示） |

---

## 3. 完整实现流程（9 条主流程）

### 3.1 启动接线
main：注册 `lume:browser-view-*` IPC 面 + `will-attach-webview` 加固（分区/参数校验）+
装配 BrowserGuestManager（含驻留协调器、恢复存储、下载/对话框控制器）。
renderer：SidePane 控制器订阅全部事件通道；面板挂载时对账快照（内存级，LRU 50 工作区，不落盘）。

### 3.2 Tab 创建（agent 路径）
`tabs_new` → 门面（sidecar）→ broker → main `execute(newTab)` → 注册表登记 + `ready`(m→r)
→ renderer 建 webview 壳 → `attach-guest`(r→m, 带 webContentsId/residencyGeneration)
→ main 校验代数后接管 → CDP 惰性附加。**揭示模型**：按 scope 决定「展开并激活 / 后台挂载」（lde）。

### 3.3 Tab 创建（用户路径）
地址栏/弹窗拦截 → main 回传 `open-browser-url` → renderer 开新 tab + 设置导航请求
（navreq 与开 tab 同步发，挂载后导航并清空）；无壳回退系统浏览器外开。

### 3.4 自动化命令
`mcp__browser__*`（19 工具）→ 门面校验 → MAC 桥 → main 分发（22 命令 switch +
playwright 引擎）→ CDP → 结果 zod 校验。playwright 命令 = 判别联合
（domSnapshot/locator[16 操作]/evaluate/waitForURL/waitForLoadState/downloadPath/waitForEvent/fileChooserSetFiles）。
超时：基准 30s，playwright/waitFor +2s；超时先补发 cancelRequest，副作用命令标 `sideEffect: uncertain`。

### 3.5 截图
`screenshot` → `prepare`(m→r) → renderer 离屏摆位 → `ready`(r→m, surfaceScale) →
main 捕获（视口 `capturePage` 1×1 泵 / beyond-viewport 泵）→ `release` 恢复布局。

### 3.6 录制
`recording.start` → 每tab一录制 → 上述 displayMedia 链 → 异步任务（可跨 turn）→
`status` 轮询 → 完成 `downloadPath` 取 webm。动作 DSL：wait/click/type/hover/move/scroll/scrollTo/wheel/drag/waitFor。

### 3.7 挂起/恢复
空闲调度器 tick → `suspend`(m→r) → renderer 卸 webview → `suspend-ready` ack → 驻留 suspended。
用户/agent 激活挂起 tab → `ensure-resident`(r→m) → restoring → `restore`(m→r) → webview 重挂（BROWSER_RESTORE_URL）。

### 3.8 关闭/崩溃/恢复存储
关闭一律 main 权威（renderer 请求 → 裁决 → 事件回声幂等）。崩溃自愈：
`render-process-gone`/`did-fail-load` → 重建代数 +1 重挂；不可自愈走错误卡（LTt/ITt 分型）。
窗口重建 → `restore-tabs` 从 JSON 恢复存储拉 shell 列表；重开换新 id、剥 residency。

### 3.9 下载/对话框
`will-download` → downloadId 追踪 + `downloadPath` 落地；JS 对话框：guest preload
`sendSync` 桥接 alert/confirm（`lume:embedded-browser-javascript-dialog`），automation 侧可自动应答。

---

## 4. ZCode 代码位置总表

### 4.1 渲染器（styles-C2WGZ-SY.js，4,584,754 bytes）

| 符号 | 职责 | 位置 |
|---|---|---|
| `Qde` | SidePane 控制器（tab 工厂/揭示/导航请求） | @214029 |
| tab 工厂区 | 全部 tab kind 工厂（browser/browser-use/terminal/git/whiteboard/trajectory…） | @196618–196980 |
| `$ue`/`Wue`/`que` | 白板/轨迹/开发者工具 tab 工厂 | 198932 / 196428 / 196800 |
| 归属判定 `xd` | browser-use→sessionId===owner；其余全局可见 | @207032 |
| 单例集 `tde` | git/repo-wiki/developer-tools/treemapping | @196.0K |
| 最近关闭环 `Xde` | 容量 8；排除 browser-use/selection-side-chat | @213793 |
| 挂起占位 `hAt` / `browserViewSuspendReady` | 空壳渲染 + ack | @3798562 / @224581 |
| 操作横幅 `kde`/`aEt` | browserUseOperationUntil = now+5000 | — |
| 截图 staging | fixed + opacity:.001 摆位 | — |
| `CTt`/`wTt` | xterm.js 终端组件/懒加载 | @3622250 / @3635065 |
| xterm 打包体 | @3329662+ | — |
| 终端会话注册表 `Hu` | sidepane + 底部面板共享（attachDom/detachDom stash） | @130246–130677 |
| `Zde` | 终端 tab 查重命名（cwd.basename+序号） | @213803 |
| `WDt`/白板 store `On`(skillStore @~33350) | 白板面板/内存 store | @3718472 |
| GitAutoRefresh `Epe` | fileWatcher watch → 60s 防抖刷新 | @277633 |
| `YEt` | Git 面板主体（来源下拉/虚拟列表/懒 diff/查找 KEt @633-653） | S1:657-975 |
| `bme`/`lse` | 全局快捷键（Ctrl+Alt+B 开合右面板） | @295657 / @66110 |

### 4.2 Main（out/main/index.js，2.27MB）

| 符号 | 职责 | 位置 |
|---|---|---|
| `createBrowserWindow` | webviewTag:true 主窗 | @1261607 |
| 窗口键 `local-${webContents.id}` | 每窗口独立 host 映射 | @1301xxx |
| `BrowserTabResidencyCoordinator`(`Gg`) | 驻留状态机（windowId 分组，LRU 32） | @922700 |
| `browserViewEnsureResident` | 唤醒挂起 tab | @224581 |
| `BrowserGuestManager` | 唯一状态权威（46 命令 execute） | 见提取源 01 |

### 4.3 Host（out/host/index.js，2.27MB）——无浏览器代码

| 符号 | 职责 | 位置 |
|---|---|---|
| node-pty lazy load | `node-pty is unavailable in this runtime` | @112907 |
| `createTerminalService` | PTY 会话表（ConPTY 双段降级） | @116729–117943 |
| `gitService`（18 方法 RPC） | git CLI 执行层 | @69642 |
| `createGitCliRepo`/`createGitCommandProvider` | spawn git（超时/输出上限常量 @26897） | @64688 / @33425 |
| ChannelServer 装配 | ServiceCollection → 通道（git/file/terminal/file-watcher…） | @2259233 |

### 4.4 提取源映射（主仓 `.zcode/analysis/extracted/`）

| 文件 | 内容 | 原始规模 |
|---|---|---|
| 01-browser-guest-manager.source.js | tab 注册表/claim/挂起/恢复/下载/对话框 | 2834 行 |
| 02-execution-engine.source.js | 命令分发 + playwright-over-CDP 引擎 | 3064 行 |
| 03-screenshot-subsystem.source.js | 摆位/捕获泵/透明引导 | 984 行 |
| 04-renderer-panel.source.js | SidePane/webview 池/工具栏 | 4076 行 |
| 05-webm-recorder.source.js | MediaRecorder 链 | 389 行 |
| 06-ipc-and-wiring.source.js | IPC 面 + 加固 + 网络策略 | 930 行 |
| 07-residency-coordinator.clean.js | 驻留状态机（语义化重命名） | 284 行 |
| 08-input-primitives.clean.js | CUA 输入原语 | 184 行 |
| 09-plugin-facade.source.mjs | 门面 SDK | 2765 行 |
| injected-scripts/runtime-exact/ | 字节级还原的注入脚本（14 文件） | — |

### 4.5 通道面（前缀替换 `zcode:` → `lume:`）

`browser-view-ready / operation / visibility / viewport-changed /
screenshot-surface-{prepare,ready,release} / close-tab / suspend / restore /
attach-guest / detach-guest / close-tab-from-renderer / report-residency /
suspend-ready / ensure-resident / restore-tabs / update-viewport /
open-browser-url / embedded-browser-javascript-dialog` +
fork RPC（terminal:create/write/resize/dispose/data/exit；browser-execute MAC+sequence）。
完整常量与形状见 Lume `packages/shared/src/browser/constants.ts` / `protocol.ts`。

---

## 5. Lume 对齐实现映射（PR #860）

| ZCode 实体 | Lume 文件 |
|---|---|
| BrowserGuestManager | `apps/desktop/src/browser/core/guest-manager.ts` |
| 驻留协调器 Gg | `apps/desktop/src/browser/core/residency.ts` |
| 执行引擎（22 命令 + playwright 引擎） | `apps/desktop/src/browser/core/executor/dispatcher.ts` + `locator-session.ts` + `dom-snapshot-session.ts` + `actions.ts` |
| 注入脚本加载 Fg | `apps/desktop/src/browser/core/executor/injected-loader.ts`（playwright-core 1.59.1，build.ts 有提前失败闸） |
| 截图子系统 | `apps/desktop/src/browser/core/screenshot-surface.ts` |
| WebM 录制 | `apps/desktop/src/browser/core/recording/recorder.ts` |
| CUA 输入 | `apps/desktop/src/browser/core/input.ts` |
| 对话框/恢复存储/空闲调度 | `core/dialog-controller.ts` / `core/recovery-store.ts` / `suspend-scheduler.ts` |
| IPC 面与加固 | `apps/desktop/src/browser/ipc.ts` + `main.ts` 接线 |
| SidePane/tab 模型/揭示 | `apps/web/src/components/browser/*`（useBrowserPanel/SidePane/BrowserTabStrip/open-browser-url-bridge 等） |
| node-pty 终端服务 | `apps/sidecar/src/services/terminal/terminal-service.ts`（ConPTY 降级/环境/locale 与 ZCode 同款） |
| xterm 终端面板 | `apps/web/src/components/terminal/TerminalPanel.tsx`（多实例会话键） |
| Git 面板（只读/查找/菜单/迁移） | `apps/web/src/components/right-panel/GitPanel.tsx` + `apps/desktop/src/browser/git-panel-service.ts` + `git-watcher.ts` |
| 白板 WDt/On | `apps/web/src/components/whiteboard/*`（store/canvas/panel） |
| 门面/传输 | `apps/sidecar/src/services/browser/*`（iab-backend 命令无关代理 + MAC 桥 + 协议闸） |
| 协议单源 | `packages/shared/src/browser/*`（protocol/constants/capabilities/errors/descriptor） |
| tab 模型/实例 | `apps/web/src/components/right-panel/right-panel-state.ts`（terminal/whiteboard 非单例）+ `right-panel-workspace-store.ts` + `atoms/right-panel-atoms.ts` |

---

## 6. 验证体系

1. **静态审计**：功能覆盖 36/36；命令面为 ZCode 超集（顶层 24 vs 22；locator 16/16）；
   guest-manager 特性面、渲染 UI 面（11/11）、交互面（P4 逐条）、外壳迁移（Q11 §3.1）逐条核对。
2. **运行时 e2e**：`apps/desktop/scripts/browser-rewrite.e2e.mjs`——真实 Electron 驱动
   newTab→attach→navigate→snapshot→screenshot→suspend→ensureResident→recording→close→recovery，24 断言通过。
3. **实包验证**：全构建链（tsc/vite/cargo/bundle 脚本）+ electron-builder `--dir` 实包；
   `app.asar` 内 playwright-core 的 `injectedScriptSource.js` 与 dev 文件 sha256 一致；
   extraResources 内 node-pty（conpty 预编译）真实加载。playwright-core 钉 1.59.1，
   `apps/desktop/scripts/build.ts` 有缺失即失败的构建闸。

## 7. 有意偏差清单

| 偏差 | 理由 |
|---|---|
| 终端 shell 探测末级静默回落（ZCode 抛错）；不做 darwin spawn-helper chmod/PATH 合并 | 平台必有默认 shell；依赖 mxc-sdk 预编译产物 |
| win32 PTY 不传 `encoding` | node-pty 不支持并告警，行为等同 |
| create 不返回字体/主题字段 | renderer 非 xterm 设置面，留 xterm 升级路径 |
| git 面板无 last-turn 来源 | ZCode 该构建中恒为空占位 |
| 白板「加入聊天」→ PNG 下载 | Lume composer 无附件暂存通道 |
| Chrome 数据导入（importChromeBrowserData）不移植 | Cookie 解密依赖提权 helper/Windows App-Bound key reader/macOS 钥匙串基础设施；清除数据（W1，cache/all 两模式）已实现 |
| 右面板状态不落盘（内存 + LRU 50） | ZCode 同语义 |
| 浏览器 devtools/下载 UI/权限 UI | 双方均无（ZCode developer-tools 是 token 调试面板，非浏览器 devtools） |
