# Lume 内嵌浏览器代码删除清单（repo: D:\workspace\projects\ai-projects\lume-browser-align，branch feat/browser-zcode-alignment）

审计范围覆盖 apps/desktop、apps/web、apps/sidecar、packages/shared、crates、构建脚本。行号以当前分支工作区为准。

---

## A. 整文件删除（wholly-browser）

### A1. apps/desktop/src（主进程浏览器运行时 + guest/auth preload + overlay，共 41 个文件 + 1 个目录）
全部 `browser-*` 文件彼此构成封闭依赖图，唯一外部入口是 main.ts（见 B1），删除后无其他非浏览器文件引用它们：

- apps/desktop/src/browser-runtime.ts（唯一聚合体，import 了下面几乎所有模块）
- apps/desktop/src/browser-action-effect.ts / .test.ts
- apps/desktop/src/browser-action-queue.ts / .test.ts
- apps/desktop/src/browser-agent-script.ts / .test.ts
- apps/desktop/src/browser-annotation-manager.ts / .test.ts
- apps/desktop/src/browser-annotation-security.ts / .test.ts
- apps/desktop/src/browser-annotation-session.ts / .test.ts
- apps/desktop/src/browser-audit.ts
- apps/desktop/src/browser-auth-preload.ts
- apps/desktop/src/browser-cdp-input.ts / .test.ts
- apps/desktop/src/browser-credentials.ts（浏览器密码保险库；与保留的 connection-vault.ts 无关）
- apps/desktop/src/browser-cursor.ts
- apps/desktop/src/browser-download-sweep.ts / .test.ts
- apps/desktop/src/browser-downloads.ts / .test.ts
- apps/desktop/src/browser-guest-preload.tsx / .declarations.test.ts / .webmcp.test.ts
- apps/desktop/src/browser-import.ts（Chrome profile 导入；被 browser-credentials.ts 与 main.ts 引用）
- apps/desktop/src/browser-input-ledger.ts / .test.ts
- apps/desktop/src/browser-locator.ts / .test.ts
- apps/desktop/src/browser-network-guard.ts
- apps/desktop/src/browser-reference-grants.ts
- apps/desktop/src/browser-residency-policy.ts
- apps/desktop/src/browser-runtime-policy.ts
- apps/desktop/src/browser-semantic-snapshot.ts / .test.ts
- apps/desktop/src/browser-sharing-policy.ts
- apps/desktop/src/browser-webmcp-consumer.test.ts
- apps/desktop/src/browser-workspace-store.ts / .test.ts
- apps/desktop/src/browser-overlay/（整个目录：AnnotationOverlay、CursorBadge、DeclarationInput、DesignEditor、EditorCard、Marker、PreviewCard、SelectionHighlight、anchor、guest-state、overlay.css、overlayReducer、sectionGroups、useAnnotationInteraction、useScrub 及各自 .test）
- apps/desktop/src/webmcp-shim.ts / .test.ts（唯一消费方是 browser-guest-preload.tsx）
- apps/desktop/src/main-webmcp-ipc.wiring.test.ts（源码断言 `lume:get-browser-webmcp-enabled` 接线，随主进程接线一起删）
- apps/desktop/src/plugin-native-host-installer.ts + scripts/plugin-native-host-installer.test.mjs（**Chrome 扩展 Native Messaging Host 安装器**，导出仅为 `ChromeNativeHostInstallPlan`/`createChromeNativeHostInstallPlan`/`writeChromeNativeHostRegistration`，kind 仅 'chrome-native-host'，属扩展后端；唯一消费方 main.ts L141-144/L2341）

### A2. apps/desktop/scripts（14 个）
browser-runtime.e2e.mjs、browser-extension-smoke.mjs、browser-import-live-smoke.mjs、browser-import.test.mjs、browser-audit.test.mjs、browser-credentials.test.mjs、browser-cursor.test.mjs、browser-downloads.test.mjs、browser-network-guard.test.mjs、browser-reference-grants.test.mjs、browser-residency-policy.test.mjs、browser-runtime-policy.test.mjs、browser-sharing-policy.test.mjs、browser-workspace-store.test.mjs

### A3. apps/web/src（17 个）
- apps/web/src/components/browser/ 整目录：BrowserShell.tsx、BrowserWebviewPool.tsx、BrowserImportModal.tsx、browser-url.ts
- apps/web/src/components/tabs/BrowserTabView.tsx
- apps/web/src/components/right-panel/BrowserRightPanelTab.tsx、right-panel-browser-state.ts、right-panel-browser-state.test.ts
- apps/web/src/components/settings/BrowserSettings.tsx、BrowserDataManagers.tsx
- apps/web/src/components/agent/agent-input-browser-mention.ts、browser-annotation-submit.ts、browser-annotation-submit.test.ts
- apps/web/src/components/agent/tool-result-renderers/browser-result.tsx、browser-result.test.tsx
- apps/web/src/components/agent/message-blocks/tool-summary.browser.test.ts、browser-tool-names.sentinel.test.ts
- apps/web/src/lib/desktop-api/browser.ts
- apps/web/src/components/skills/BridgeInstallWizard.tsx + BridgeInstallWizard.test.tsx（**Chrome 桥安装向导**，扩展后端 UI；唯一消费方 SkillsMarketView.tsx，见 B4）

### A4. apps/sidecar（服务、工具、RPC、插件、skill）
- apps/sidecar/src/services/browser/ 整目录：browser-broker.ts/.test.ts、browser-broker-holder.ts、browser-action-policy.ts/.test.ts、external-chrome-transport.ts/.test.ts（含连接外部 Chrome 的传输层）
- apps/sidecar/src/services/agent-runtime/tools/browser/ 整目录：browser-tool-session.ts、create-browser-tools.ts、create-browser-tools.test.ts
- apps/sidecar/src/rpc/browser-rpc-sequence.ts + .test.ts（browser RPC 序列/MAC 专用，生产消费方仅 sidecar index.ts 与 browser-broker.test）
- apps/sidecar/src/services/agent-runtime/plugins/bundled-browser-plugin.test.ts
- apps/sidecar/bundled-plugins/browser/ 整目录（dist/browser-client.js、client/、docs/、scripts/browser-client.mjs 及其 .test、skills/browser/）
- apps/sidecar/default-skills/in-app-browser/（SKILL.md，allowedTools=mcp__browser__*）

### A5. packages/shared/src（4 个）
- packages/shared/src/types/browser-runtime.ts + types/browser-runtime.test.ts（BROWSER_PROTOCOL_*、DEFAULT_BROWSER_SETTINGS、BROWSER_IPC_CHANNELS、LUME_BROWSER_TOOL_NAMES、BrowserSettings/BrowserRequestContext/BrowserTabDescriptor 等全部浏览器协议类型）
- packages/shared/src/browser-api-registry.ts + .test.ts（生产消费方仅 desktop browser-runtime.ts 与 sidecar browser-broker.ts，二者皆删）

---

## B. 共享文件的浏览器剥离点（文件保留）

### B1. apps/desktop/src/main.ts（~3800 行，浏览器接线密集）
| 位置 | 内容 |
|---|---|
| L165-166 | `import { createBrowserRuntime, type BrowserRuntime } from './browser-runtime'`、`import { discoverChromeProfiles, importChromeProfile, importConnectedChromeCookies, type ImportedCookie } from './browser-import'` |
| L167-168 | `import type { BrowserSettings, LumeLogLevel... } from '@lume/shared'` —— 仅去掉 `BrowserSettings`，保留其余 |
| L141-144 | `createChromeNativeHostInstallPlan, writeChromeNativeHostRegistration` from './plugin-native-host-installer'（文件随 A1 删除） |
| L256-266 | 模块态：`browserRuntime`、`pendingBrowserGuestAttachments`、`agentBrowserPluginEnabled`、`browserRpcSecret`、`browserRpcInboundSequence/OutboundSequence`、`browserImportJobs` |
| L268-288 | `setImportedBrowserCookie()`（persist:lume-browser partition） |
| L873-880 | `getPersistedBrowserSettings()`、`persistBrowserSettings()` |
| L882-896 | `browserRpcMac()`、`verifyBrowserRpcMac()` |
| L1364-1405 | `attachBrowserGuestSecurity()` 整个函数（will-attach-webview / did-attach-webview） |
| L1407-1409 | `stripBrowserGuestMountToken()` |
| L1426 | createMainWindowForGeneration 的 `webviewTag: true`（全仓唯一 `<webview>` 消费方是待删的 BrowserWebviewPool） |
| L1430 | `attachBrowserGuestSecurity(win)` 调用 |
| L1951-2040 | dispatchCommand 分支：`browser_runtime`、`browser_settings:get`、`browser_settings:update`（含完整 CDP dialog 确认）、`browser_import:discover/start/cancel` |
| L2325-2365（符号级） | plugin-package 安装命令内的 `installer.kind === 'chrome-native-host'` 分支及 `createChromeNativeHostInstallPlan`/`writeChromeNativeHostRegistration` 调用（插件包下载通道本身保留） |
| ~L2880-2933 | `readChromeBridgeConfig()`（校验 lume-chrome-host 原生桥配置，含 L2916 的 `lume-browser-*` 命名管道正则、lume-chrome-host 校验）——扩展后端，删 |
| L2932, L2953-2959 | createSpawnConfig 中 `const chromeBridge = readChromeBridgeConfig()`、env `LUME_BROWSER_RPC_SECRET` 与 `LUME_CHROME_BRIDGE_ENDPOINT/PAIRING_ID/GENERATION/HOST_PATH/HOST_SHA256` |
| L3046-3047 | start() 中 browserRpc 序列归零 |
| L3250-3290 | sidecar 消息循环内 `browser:request`（MAC 校验+dispatchCommand('browser_runtime')）、`browser:plugin-state`、`browser:backend-state` 三个分支 |
| L3479-3492, L3518 | `notifyBrowserSettings()` 及其在 createSidecarHost 返回对象的导出（通用原语 `notify()` L3519-3525 保留，删注释中“与 notifyBrowserSettings 同型”措辞可选） |
| L3541-3552 | `ipcMain.on('lume:browser-guest-mounted', ...)` |
| L3555-3560 | `ipcMain.on('lume:get-browser-webmcp-enabled', ...)` |
| L3736-3741 | `app.on('child-process-gone')` 保留，仅日志通道名 `'browser.guest'` 改为如 `'app.child-process'` |
| L3747-3779 | `browserRuntime = createBrowserRuntime({...})` 整块 |
| L3787 | `await sidecarHost.notifyBrowserSettings?.(browserRuntime.getSettings())` |
| L3854-3857 | will-quit 中 pendingBrowserGuestAttachments 清理 + `browserRuntime?.destroy()` |

**weread 验证**：`open_weread_key_webview`（L2801-2833）与 `wereadWindow`（L295）仅用 `createSecureWebPreferences()`（无 webviewTag、无 browserRuntime），完全保留。

### B2. apps/desktop/src/preload.ts —— **无需改动**
preload.ts 是通用 invoke/list 桥（174 行，0 处 browser 字样）。浏览器 API 面完全由白名单决定，真正的剥离点是：

- apps/desktop/src/renderer-ipc-contract.ts：L64-69（invoke 允许列表中 `browser_runtime`、`browser_settings:get/update`、`browser_import:discover/start/cancel`）、L98（事件通道 `browser:event`）
- packages/shared/src/types/renderer-allowlist.ts：L15 import `BROWSER_IPC_CHANNELS`（孤儿导入，见 D）、L59 `BROWSER_CHANNEL_VALUES`、L91 排除判断、L99-109 注释及 `browser:backends / browser:reference-candidates / browser:create-reference-grant / browser:revoke-reference-grant` 只读白名单

### B3. apps/web/src 剥离点
- main.tsx：L20 import + L56-58 `<BrowserWebviewPoolProvider>` 包裹
- components/tabs/TabBar.tsx：L9 `browserRuntime` import；L18-19 关闭浏览器标签分支
- components/tabs/TabContent.tsx：L10 import；L63-65 `activeTab.type === 'browser'` 渲染分支
- components/tabs/file-tabs.test.ts：L3 `normalizeUrl` from './BrowserTabView'（孤儿，见 D）
- components/tabs/file-tabs.test.ts 之外：file-tabs.ts 无浏览器引用，保留
- components/right-panel/index.ts：L1 `export * from './BrowserRightPanelTab'`
- components/right-panel/RightPanelTabBar.tsx（重度剥离）：L29 类型 import；L41 `kind:'browser'` 联合项；L48 FUNCTION_META.browser；L59-66 buildRightPanelTabItems 的 browserTabs；L82-102 全部 on*Browser props；L112-144 激活/关闭逻辑；L161-217 图标与 loading/crashed/favicon/handoff/mediaState 状态；L236-260 浏览器右键菜单
- components/right-panel/RightPanelTabBar.test.ts：`createBrowserTab` 相关用例（L4 import）
- components/right-panel/RightPanelWorkspace.tsx：L49 import BrowserRightPanelTab、L60 right-panel-browser-state 导入块，及浏览器标签生命周期/`browserRuntime` 调用区域（重度剥离）
- components/settings/SettingsView.tsx：L31 import + L141 `{tab === 'browser' && <BrowserSettings .../>}` 及 tab 类型中的 'browser'
- components/agent/AgentInput.tsx：L61、L63 两行 import + 145 处浏览器提及（@浏览器 mention、标注提交、browser review session 草稿流）；对应删除 agentBrowserAttachmentsAtom/browserReviewSessionsAtom/rightPanelBrowserWorkspacesAtom 消费点
- components/agent/message-blocks/markdown.tsx：L9 import 行中的 `browserRuntime`（保留 openExternal 等）、L21 right-panel-browser-state import、L453-477 链接“在浏览器打开”分支与 `activateThreadBrowserUrl()`
- components/agent/message-blocks/tool-summary.ts：L14 分支、L31-72 `BROWSER_TOOL_PREFIX/BROWSER_TOOL_LABELS/summarizeBrowserInput`
- components/agent/tool-result-renderers/index.tsx：L16 import + L27 分发分支
- components/agent/slash-command-state.ts：L1 `BrowserReferenceCandidate` 类型、L3 `'browser'` MentionItemType、L4 `'browser-tab'/'chrome-page'` MentionSection、L23 `browserCandidate` 字段
- atoms/right-panel-atoms.ts：L1 ThreadBrowserWorkspace import；L86-92 rightPanelBrowserWorkspacesAtom；L107-117 BrowserPageDraft/browserPageDraftsAtom；L120-141 BrowserReviewSession/browserReviewSessionsAtom/browserReviewCoachmarkSeenAtom
- atoms/agent-atoms.ts：L86-90 agentBrowserAttachmentsAtom + family（L3 import 中的 AgentBrowserAttachment）
- hooks/pending-interactive-state.ts + .test.ts：L55-111 `upsertPendingBrowserAuthRequest/removePendingBrowserAuthRequest` 及对应用例（UI 无其他消费方）
- hooks/useReleaseThreadState.ts：L53、L68、L101 agentBrowserAttachmentsAtom 清理
- lib/desktop-api/index.ts：L18 `export * from './browser'`
- lib/desktop-api/agent.ts：L87 `browserAttachments` 透传
- lib/desktop-api/system.ts：L44-… `clearBrowserCaches()` 及 L173-181 在 clearCache 结果合并中的 browserResult
- components/skills/SkillsMarketView.tsx：L91 import + L824 `<BridgeInstallWizard>`（Chrome 桥向导挂载）

### B4. apps/sidecar 剥离点
- src/index.ts：L31（browser-rpc-sequence import）、L41-43（createBrowserBroker/setActiveBrowserBroker/ExternalChromeTransport）、L50（getBrowserToolSessionRegistry）、L64-77（BROWSER_REQUEST_TIMEOUT_MS/BROWSER_CONFIRMATION_TIMEOUT_MS/pendingBrowserMainRequests/browserRpcSecret/序列）、L87-~135（`requestBrowserMain()`）、L180-191（backend-state 通知 + browserBroker 创建 + createRpcHandlers 传参）、L221-238（browserRpc 响应 MAC 校验）、L262-263（tab-closed/tab-changed 缓存失效）、L355（`browser:settings` handler）、L651-653（stop 清理）
- src/rpc/create-rpc-handlers.ts：L1（BrowserReferenceGrantInput）、L20、L24、L29（browserBroker context 字段）、L32-73（三个 zod schema + validateBrowserInput）、L103-114（browserEnabledFromSettings/agentBrowserUseEnabledFromSettings/notifyBrowserPluginState）、L134（传给 agent-handlers）、L148-179（`browser:settings/broker/backends/chrome-import-status/export-chrome-cookies/reference-candidates/create-reference-grant/revoke-reference-grant` handlers）；注意 `notify()`/writeNotification 通用机制保留
- src/rpc/agent-handlers.ts：L187 deps.`notifyBrowserPluginState` 字段、L1170 传参
- src/rpc/plugin-handlers.ts：L79 deps 字段；L128-129/L140-141/L152-153/L164-165 中 `itemId/pluginId === "browser" || === "lume-chrome"` 触发块
- src/rpc/schemas.ts：L91-233（agentBrowserTabAttachmentSchema/agentBrowserAnchorSchema/agentBrowserDesignDeclarationSchema/agentBrowserAttachmentSchema）、L273-324（agent 输入的 browserAttachments 字段 + screenshotRef 细化校验）、L1101（另一处 browserAttachments）
- src/services/agent/agent-service.ts：L9/L81 import、L98 `onBrowserAuthRequest` 选项、L1280-1297（browserContinuity + browserAttachments 注入）、L1621-1627（onBrowserAuthRequest emit）、L1997、L2092-2119（steer 富摘要 `<browser_attachments>` 信封与透传）
- src/services/agent/agent-thread-manager.ts：L793-800 线程关闭时向 broker dispatch 释放标签页的动态 import 块
- src/services/agent/agent-prompt-builder.ts：L24 import、L416-418 buildBrowserFirstSection 注入
- src/services/agent/prompt/sections/interaction-policy-sections.ts：L1 import、L49-73 `buildBrowserFirstSection()` 整函数
- src/services/agent/prompt/sections/static-policy-sections.ts：L9 文案中的 “browser/” 一词（保留 Computer Use 部分）
- src/services/agent/agent-submission-store.ts：L401 browserAttachments 持久化字段
- src/services/agent/agent-file-ref.ts：L329-331 `resolveAuthorizedBrowserUploadPaths`、L447-463 `resolveAuthorizedBrowserPreviewPath`（生产调用方仅待删的 browser-broker.ts；配套 agent-files-service.test.ts L32-33/L243-268 用例一并删）
- src/services/agent-runtime/runtime-core/types.ts：L4 import、L15 `onBrowserAuthRequest` 字段
- runtime-core/run-tools.ts：L54、L224、L301、L444、L585 emitBrowserAuthRequest 透传
- runtime-core/run.ts：L24/L33/L74 import、L222/L239 字段、L667-669（browser:browser skill 抑制逻辑）、L739-742（browserAttachments/browserRuntimeAvailable/browserContinuity 传入 context assembler）、L1212
- runtime-core/run-state.ts：L2、L55 browserAttachments
- runtime-core/run-subagent.ts：L19、L295、L445、L702、L814 onBrowserAuthRequest/emitBrowserAuthRequest
- runtime-core/run-item-events.ts：L48-62 browserAttachments 写入 run item
- runner/lume-runner.ts：L55-56 import、L409-424（run 结束时 browser tool session keep/handoff dispatch）、L488、L506
- runner/mock-attempt.ts：L95、L300、L370
- context/context-assembler.ts：L1-2 类型 import、L35-40（browserAttachments/browserRuntimeAvailable/browserContinuity 输入）、L211-258（hasBrowserRuntime 判定 + browserFallbackPolicy + browserContinuityPolicy）、L278-291（section 组装）、L301-330（browserBrief/browserInstructions/browserAnnotationInstructions）
- tools/create-lume-tools.ts：L3（AgentBrowserAuthRequest）、L32-33 import、L143、L165-167（`browserTools = threadType==='subagent' || !isBundledBrowserRuntimeAvailable() ? [] : createBrowserMcpTools(...)`）、L183 spread
- tools/node-repl/create-node-repl-tools.ts：L3/L9-10/L15 import、L27、L84（resolveBrowserAuthRequest 接线）、L121-140（`browserRequest` → broker）
- tools/node-repl/node-repl-runtime-manager.ts：L10 类型、L342-370（host 消息 `browser.request`/`browserAuth.request` 处理）、L430（browser-client.mjs permission 条目）、L438（permission==='browser' 判断）
- tools/node-repl/node-repl-types.ts：L2 `js` 工具描述中的浏览器自动化引导段、L26-75（NodeReplBrowserAuthRequest/Result、BrowserLocator/BrowserAuthOption 字段）
- plugins/plugin-manager.ts：L112-121 `isBundledBrowserPluginAvailable`/`isBundledBrowserRuntimeAvailable` 两个导出（其余保留）
- automation/automation-runner-service.ts：L355-357 `onBrowserAuthRequest` no-op stub
- services/im/im-message-router.ts：L132 `onBrowserAuthRequest` 字段、L979-981 IM 通道 stub；services/channel/model-selection.test.ts L446/L494/L558/L612 的 mock 字段
- crates/lume-node-repl-host/src/kernel.rs：L133/L144/L1249/L1269 `NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S`、`BROWSER_USE_DISABLE_AMBIENT_NETWORK` env 管道（可留空实现，建议一并剥离）
- 文案类（保留文件，改字符串）：tools/computer-use/create-computer-use-tools.ts L794 提及 browser 工具的描述
- 仅注释/无实义（保留）：context/context-controller.ts L130、tools/tool-runtime-wrapper.ts L56、services/infra/proxy-config-holder.ts L4、connectors/core/guarded-fetch.ts L54、connectors/core/types.ts L91、tools/im-cli/providers/dingtalk.ts L40（--no-browser 是 CLI 旗标）

### B5. packages/shared/src 剥离点
- src/index.ts：L10 `export * from "./browser-api-registry"`
- src/types/index.ts：L37 `export * from "./browser-runtime"`
- src/types/renderer-allowlist.ts：见 B2
- src/types/rpc-error.ts：L96-97 `BROWSER_UNAVAILABLE` 错误码（生产消费方仅 sidecar index.ts L131，已随 B4 删；web/sidecar 错误文案表无该码，可安全删）
- src/types/agent.ts：L811/L855/L1129 `browserAttachments` 字段；L892-1024 浏览器附件类型群（AgentBrowserTabAttachment/AgentBrowserAnchor/AgentBrowserAnnotationAttachment/BrowserAnnotationSessionSnapshot/AgentBrowserDesignDeclaration/AgentBrowserDesignChangeAttachment/AgentBrowserAttachment 联合）；L1184-1222 浏览器认证类型群（AgentBrowserAuthStatus/Field/Request/ResponseInput）；L1322 `browserAuthRequests`
- src/tool-names.ts：L1-6 `BROWSER_MCP_SERVER_ID/BROWSER_TOOL_NAME_PREFIX/isBuiltinBrowserToolName`（消费方：context-assembler、interaction-policy-sections、run.ts，均为 B4 剥离点；可随删或保留空壳，建议随删）

### B6. 构建与配置
- apps/desktop/vite.config.ts：L41-42 preload 多入口中 `browser-auth-preload`、`browser-guest-preload`
- apps/desktop/package.json：L23 test:smoke 中 `./src/browser-workspace-store.test.ts`、`./src/browser-annotation-session.test.ts`、`./src/browser-annotation-manager.test.ts`；L24-27 四个 `test:browser-*` scripts；L56-57 electron-builder files 数组中 `dist/preload/browser-auth-preload.cjs`、`dist/preload/browser-guest-preload.cjs`
- apps/sidecar/package.json：L17 test:unit 中 `&& bun run test:browser-client`、L18 `test:browser-client` script
- apps/desktop/scripts/test-electron-mock.ts：**保留**（通用 Electron mock，仅注释提及 browser-runtime/guest-state）
- settings-broker.ts：**保留**（RootSettings 为 `Record<string, unknown>`，`browser` 键仅由 main.ts 读写；存量用户配置里的 browser 键无害残留）

### B7. sidecar 内受影响的既有测试（保留文件、删用例/import）
lume-runner.test.ts（L14-15 broker/session import 及相关用例）、create-node-repl-tools.test.ts（L5）、node-repl-runtime-manager.test.ts、create-lume-tools.test.ts、plugin-manager.test.ts、agent-service.test.ts（L540 动态 import）、run.test.ts、run-loop.test.ts、run-observer.test.ts、attempt-guidance.test.ts、attempt-observability.test.ts、run-guidance-store.test.ts、context-assembler.test.ts、agent-prompt-builder.test.ts、agent-user-message-parts.test.ts、agent-files-service.test.ts（browser upload/preview 用例）、schemas.agent-attachments.test.ts、schemas.agent-message-parts.test.ts、create-rpc-handlers.test.ts、model-selection.test.ts、default-skills-inventory.test.ts（L91-97/L109/L157/L174 in-app-browser 条目）

---

## C. 必须保留（浏览器邻近但非浏览器栈）

| 路径/功能 | 保留理由 |
|---|---|
| apps/desktop/src/file-protocol.ts | lume-file://preview 协议（html-directory/media-file），服务 office/HTML 预览；仅 main.ts 引用；内部 0 浏览器代码。方向是 browser-runtime→file-protocol，删除方向安全 |
| apps/desktop/src/office-preview.ts 及 .test | LibreOffice→HTML 预览，无 browser import |
| apps/desktop/src/connection-vault.ts | API Key 保险库，与浏览器密码库（browser-credentials.ts）无关 |
| apps/desktop/src/text-insertion-service.ts、electron-security.ts、renderer-sidecar-methods.ts（除 allowlist 联动）、attachment-staging.ts、desktop-host-supervisor.ts、tray-manager.ts、page-renderer.ts、plugin-asset-registry.ts | 0 浏览器引用；page-renderer 的 "BrowserWindow" 是 Electron 类名 |
| main.ts weread 窗口（L2801-2833、wereadWindow L295、validateWereadUrl、createWereadTipScript） | 已验证不使用 browserRuntime/webviewTag |
| apps/desktop/src/preload.ts | 通用桥，无浏览器面（见 B2） |
| apps/web/src/components/file-browser/*（FileBrowser、WorkspaceFileBrowser） | “file-browser” 是本地文件浏览器，与内嵌浏览器无关 |
| McpsSettings.tsx L831/L839 `name.includes('browser')` 图标启发式、VersionUpdateSettings L195 `browser_download_url`（GitHub release 字段） | 命名巧合，保留 |
| sidecar node-repl 全套（除 B4 列点）、computer-use、插件系统、plugin-package 下载通道、sidecarHost.notify() 通用原语 | 共享基础设施 |
| crates/lume-ast、lume-desktop-host、lume-natives | 无浏览器代码 |
| 连接外部 Chrome 的用户已导入数据目录（persist:lume-browser partition 落盘数据） | 随代码删除不再写入，无需迁移逻辑 |

---

## D. 孤儿导入风险清单（删除 A 后会 typecheck/测试失败的存活文件，必须完成对应 B 剥离）

1. apps/desktop/src/main.ts → ./browser-runtime、./browser-import、@lume/shared BrowserSettings、./plugin-native-host-installer
2. packages/shared/src/types/renderer-allowlist.ts → ./browser-runtime（BROWSER_IPC_CHANNELS）——shared 包自身会先编译失败
3. packages/shared/src/types/index.ts、src/index.ts → 两个被删模块的 re-export
4. packages/shared/src/types/agent.ts、rpc-error.ts → 仅类型/常量自含，需同步删字段否则 web/sidecar 引用方报错
5. apps/web/src/main.tsx → components/browser/BrowserWebviewPool
6. apps/web/src/components/tabs/TabBar.tsx → @/lib/desktop-api（browserRuntime 经 index.ts L18 再出口）
7. apps/web/src/components/tabs/TabContent.tsx → ./BrowserTabView
8. apps/web/src/components/tabs/file-tabs.test.ts → normalizeUrl（原经 BrowserTabView 转出口自 browser-url.ts；需内联或移入 file-tabs.ts）
9. apps/web/src/components/right-panel/index.ts → ./BrowserRightPanelTab
10. apps/web/src/components/right-panel/RightPanelTabBar.tsx / RightPanelTabBar.test.ts / RightPanelWorkspace.tsx → ./right-panel-browser-state（类型 + createBrowserTab）
11. apps/web/src/components/settings/SettingsView.tsx → ./BrowserSettings（含 'browser' tab 键）
12. apps/web/src/components/agent/AgentInput.tsx → ./agent-input-browser-mention、./browser-annotation-submit
13. apps/web/src/components/agent/message-blocks/markdown.tsx → right-panel-browser-state + browserRuntime
14. apps/web/src/components/agent/message-blocks/tool-summary.ts → 无模块导入但引用 shared `LUME_BROWSER_TOOL_NAMES` 语义（哨兵测试已删）；`isBuiltinBrowserToolName` 消费方 context-assembler/interaction-policy/run.ts 同理
15. apps/web/src/components/agent/tool-result-renderers/index.tsx → ./browser-result
16. apps/web/src/components/agent/slash-command-state.ts → @lume/shared BrowserReferenceCandidate
17. apps/web/src/atoms/right-panel-atoms.ts → ThreadBrowserWorkspace；atoms/agent-atoms.ts → AgentBrowserAttachment
18. apps/web/src/hooks/pending-interactive-state.ts(+.test) → AgentBrowserAuthRequest；hooks/useReleaseThreadState.ts → agentBrowserAttachmentsAtom
19. apps/web/src/lib/desktop-api/index.ts → ./browser；lib/desktop-api/agent.ts → shared browserAttachments 字段
20. apps/web/src/components/skills/SkillsMarketView.tsx → ./BridgeInstallWizard
21. apps/sidecar/src/index.ts → browser-rpc-sequence、browser-broker、browser-broker-holder、external-chrome-transport、browser-tool-session、shared BROWSER_HANDLER_WAIT_CAP_MS、RPC_ERROR_CODES.BROWSER_UNAVAILABLE
22. apps/sidecar/src/rpc/create-rpc-handlers.ts → browser-broker 类型、plugin-manager 两个函数、shared BrowserReferenceGrantInput
23. apps/sidecar/src/rpc/schemas.ts → shared 浏览器附件类型链（zod schema 自含但引用共享类型）
24. apps/sidecar/src/services/agent-runtime/{runner/lume-runner.ts, tools/create-lume-tools.ts, tools/node-repl/create-node-repl-tools.ts, services/agent/agent-service.ts, agent-thread-manager.ts(动态)} → browser-broker-holder / browser-tool-session / create-browser-tools
25. apps/sidecar/src/services/agent-runtime/context/context-assembler.ts、runtime-core/{types,run-tools,run,run-state,run-subagent,run-item-events}.ts、runner/mock-attempt.ts → shared AgentBrowser*/isBuiltinBrowserToolName
26. apps/sidecar/src/services/agent-runtime/tools/node-repl/node-repl-types.ts → shared BrowserLocator/BrowserAuthOption
27. D7 所列测试文件对被删模块的 import（如 lume-runner.test.ts → browser-broker-holder/browser-tool-session）

建议提交顺序：先做 shared 包剥离（D2/D3/D4）→ desktop/web/sidecar 各 B 剥离与 A 删除同 commit → 最后跑 `bun run test:core` 与 desktop `bun test ./src ./scripts` 验证无残留断点。