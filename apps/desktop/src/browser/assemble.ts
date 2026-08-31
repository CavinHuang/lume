/**
 * Lume 内嵌浏览器运行时装配 —— createLumeBrowserRuntime(集成层)。
 *
 * 来源:ZCode 装配点(01-browser-guest-manager.source.js 偏移 2680-2835 的 Kg 装配 +
 * 06-ipc-and-wiring.source.js 的 PCe/runBrowserCommandOnView 与 zM/z1 辅助)。
 * 各核心模块(core/*)按 types.ts 契约互不感知,本文件是唯一跨模块接线点。
 *
 * ZCode 原名对照:
 *   Kg  → BrowserGuestManager(core/guest-manager.ts)
 *   Gg  → BrowserTabResidencyCoordinator(core/residency.ts)
 *   YH  → createDesktopBrowserScreenshotSurfaceCoordinator(core/screenshot-surface.ts)
 *   eh  → EmbeddedBrowserJavaScriptDialogController(core/dialog-controller.ts)
 *   jg  → executeBrowserCommandOnView(core/executor/dispatcher.ts,CommandExecutor 端口)
 *   ca  → executeIabPlaywrightLocator(core/executor/locator-session.ts,IabPlaywrightLocatorExecutor 端口)
 *   TH  → handlePlaywrightAction 的 PlaywrightActionExecutorPort(core/executor/playwright-bridge.ts)
 *   K   → createElectronBrowserWebmRecorder(core/recording/recorder.ts)
 *   PCe → runBrowserCommandOnView(本文件 runtime.execute:对话框自动化括弧 + 操作事件)
 *   zM  → resolveBrowserOperationTabId(本文件,WM = readTabId)
 *   z1  → browserOperationResetsResizeBaseline(本文件)
 *   d$  → 对话框控制器单例(ZCode 模块级;Lume 经 runtime.dialogController 注入 ipc 层)
 *
 * 语义偏差(命名/平台前缀之外):
 *   1. 事件出口:ZCode 装配点直发 BrowserWindow.webContents.send(I.BrowserView*);
 *     Lume 统一经 deps.emit({method:"lume:browser-view-*", params}) 交宿主转发
 *     (main 以 `lume:event:` 前缀发往 renderer,经 preload listen 白名单)。
 *   2. 截图 CSS 像素归一:与 ZCode 装配点一致用 nativeImage resize(quality:"best"),
 *     无 sharp 依赖。
 *   3. descriptor():ZCode 无同名装配函数;经 shared/descriptor.ts 的
 *     buildIabDescriptor(ZCode plugin-facade 形状)装配期生成,供 sidecar 桥的
 *     能力协商消费(与 sidecar iab-backend 描述符同源单源)。
 *   4. 常驻挂起发起器(suspend-pending → renderer 卸载空壳 → ack → 关闭 guest)在
 *     ZCode 位于提取域外的装配段;Lume 以 manager.suspendTabForIdle(挂起协议写入端)
 *     + core/suspend-scheduler.ts(空闲裁决轮询)补齐,此处 start/dispose 接线。
 *   5. recoveryStore(壳持久化)以 core/recovery-store.ts 的 JSON 文件实现注入
 *     (`<configDir>/browser-recovery/store.json`),restoreTabs 跨重启可用。
 */

import { app, BrowserWindow, nativeImage, webContents } from "electron"
import { randomUUID } from "crypto"
import { join } from "path"
import {
  buildIabDescriptor,
  type BrowserBackendDescriptor,
} from "@lume/shared"
import { pasteTextIntoFocusedTarget, executeBrowserCommandOnView } from "./core/executor/dispatcher"
import { executeIabPlaywrightLocator, type LocatorAction, type LocatorInputPorts } from "./core/executor/locator-session"
import { createPlaywrightActionExecutor } from "./core/executor/playwright-bridge"
import {
  createDesktopBrowserScreenshotSurfaceCoordinator,
  type BrowserScreenshotSurfaceReadyPayload,
  type DesktopBrowserScreenshotSurfaceCoordinator,
} from "./core/screenshot-surface"
import { createElectronBrowserWebmRecorder } from "./core/recording/recorder"
import { EmbeddedBrowserJavaScriptDialogController } from "./core/dialog-controller"
import { BrowserTabResidencyCoordinator, type ResidencyRecord } from "./core/residency"
import {
  BrowserGuestManager,
  type BrowserGuestCommand,
  type BrowserTabResidencyCoordinatorPort,
  type BrowserTabResidencySnapshot,
  type CommandExecutor,
  type IabPlaywrightLocatorExecutor,
} from "./core/guest-manager"
import { dispatchClickAt, dispatchKey } from "./core/input"
import { assertFocusedInputTarget } from "./core/injected/text-input"
import { createRecoveryStore } from "./core/recovery-store"
import { createSuspendScheduler, type SuspendScheduler } from "./core/suspend-scheduler"
import { createGitWorkspaceWatcher } from "./git-watcher"
import type {
  BrowserCommandResult,
  BrowserEventSink,
  BrowserManagerDeps,
  BrowserOwnerContext,
} from "./core/types"
import {
  BROWSER_GUEST_PARTITION,
  type BrowserGuestAttachRequest,
  type BrowserGuestAttachResult,
  type BrowserGuestMountAuthorizer,
  type BrowserResidencyReport,
  type BrowserRestoreTabsQuery,
  type BrowserTabScope,
  type BrowserViewManagerPort,
} from "./ipc"

/** createLumeBrowserRuntime 依赖注入(main 提供;其余 Electron 静态面内部接线)。 */
export interface LumeBrowserRuntimeDeps {
  /** 宿主主窗口(ZCode 单窗口形态的 BrowserWindow.fromId 等价物)。 */
  getWindow: () => BrowserWindow | null
  /** 事件面出口:`lume:browser-view-*` 频道统一交宿主转发 renderer。 */
  emit: BrowserEventSink
  log: (message: string) => void
  warn: (message: string, error?: unknown) => void
  /** 用户配置目录(录制临时产物根目录的父目录)。 */
  configDir: string
  attachTimeoutMs?: number
  tabLimit?: number
  /** 空闲挂起判定阈值(缺省 5 分钟;测试/E2E 可调短)。 */
  suspendIdleDelayMs?: number
}

/** 渲染器 suspend-ready 载荷(ipc 层 suspendReady 通道的解析产物)。 */
export interface BrowserSuspendReadyAck {
  tabId: string
  generation: number
  windowId: number
}

/** 运行时门面:main(ipc 层)与 sidecar 桥共用的稳定入口。 */
export interface LumeBrowserRuntime {
  /** ipc 层消费的 BrowserGuestManager 可见面(createBrowserIpc deps.manager)。 */
  view: BrowserViewManagerPort
  /** 裸管理器(sidecar 桥高级路径 / 测试)。 */
  manager: BrowserGuestManager
  screenshotSurface: DesktopBrowserScreenshotSurfaceCoordinator
  dialogController: EmbeddedBrowserJavaScriptDialogController
  /** 空闲挂起调度器(start 随装配生效;E2E/测试可手动 tick)。 */
  suspendScheduler: SuspendScheduler
  /** webview will-attach 的分区强制钩子(传给 createBrowserIpc.mountAuthorizer)。 */
  mountAuthorizer: BrowserGuestMountAuthorizer
  /** 后端能力描述符(sidecar 桥能力协商;形状单源 shared/descriptor.ts)。 */
  descriptor(): BrowserBackendDescriptor
  /** 命令执行(ZCode PCe:对话框自动化括弧 + 操作事件 + 管理器分发)。 */
  execute(context: BrowserOwnerContext, command: BrowserGuestCommand, signal?: AbortSignal): Promise<BrowserCommandResult>
  attachGuest(request: BrowserGuestAttachRequest): Promise<BrowserGuestAttachResult | undefined>
  detachGuest(tabId: string, webContentsId: number, windowId: number): Promise<boolean>
  closeTab(scope: BrowserTabScope & { windowId: number }): Promise<void>
  reportResidency(report: BrowserResidencyReport): Promise<void>
  suspendReady(ack: BrowserSuspendReadyAck): Promise<void>
  ensureResident(scope: BrowserTabScope & { windowId: number }): Promise<void>
  restoreTabs(query: BrowserRestoreTabsQuery): Promise<readonly unknown[]>
  updateViewport(tabId: string, viewport: { width: number; height: number } | null, windowId: number, zoomFactor: number): Promise<void>
  /** Git 面板文件 watch：renderer 告知工作区路径（lume:browser-git-watch），变更 60s 防抖后回发 lume:browser-git-dirty。 */
  watchWorkspace(workspacePath: string): void
  /** renderer 截图表面就绪回报(ipc 层 `lume:browser-view-screenshot-surface-ready`)。 */
  handleScreenshotSurfaceReady(payload: unknown, senderWebContentsId: number): void
  /** 窗口销毁:失败该窗口在途的截图表面请求。 */
  handleWindowDestroyed(windowId: number): void
  dispose(): void
}

/** ZCode WM/readTabId:对象顶层非空字符串 tabId。 */
function readOperationTabId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined
  const tabId = (payload as { tabId?: unknown }).tabId
  return typeof tabId === "string" && tabId.length > 0 ? tabId : undefined
}

/**
 * ZCode zM/resolveBrowserOperationTabId:命令显式 tabId 优先;否则成功结果取
 * meta.tabId / tab.tabId。
 */
function resolveBrowserOperationTabId(command: BrowserGuestCommand, result?: BrowserCommandResult): string | undefined {
  return readOperationTabId(command)
    ?? (result?.ok === true ? readOperationTabId(result.meta) ?? readOperationTabId(result.tab) : undefined)
}

/** ZCode z1/browserOperationResetsResizeBaseline:可见化/激活/视口系操作重置 resize 基线。 */
function browserOperationResetsResizeBaseline(command: BrowserGuestCommand): boolean {
  if (command.method === "browserVisibilitySet") return command.visible === true
  return ["activateTab", "browserViewportReset", "browserViewportSet", "newTab"].includes(command.method)
}

/**
 * 装配 Lume 内嵌浏览器运行时:常驻协调器(A2)→ 截图表面协调器(A8)→ 执行器
 * (A4/A5/A7:dispatcher + playwright-bridge + input/text-input 原语)→ 录制(A9)
 * → 对话框控制器(A7)→ BrowserGuestManager(A3)。创建顺序仅表达依赖方向;
 * 常驻淘汰经闭包回指管理器(创建后即绑定)。
 */
export function createLumeBrowserRuntime(deps: LumeBrowserRuntimeDeps): LumeBrowserRuntime {
  /* 常驻协调器(A2):裁决(谁可挂起/淘汰)与执行(manager)解耦,
   * onEvict 回指管理器的 closeTabForLimit(创建后闭包可见)。 */
  let managerRef: BrowserGuestManager | null = null
  const residencyCoordinator = new BrowserTabResidencyCoordinator({
    ...(deps.tabLimit === undefined ? {} : { tabLimit: deps.tabLimit }),
    onEvict: (record) => {
      const current = managerRef
      const snapshot = toResidencySnapshot(record)
      return !!(current && snapshot && current.closeTabForLimit(snapshot))
    },
  })
  /** 常驻记录 → 管理器端口的快照投影(lastSelectedAt 归一为 number|null)。 */
  function toResidencySnapshot(record: ResidencyRecord | null): BrowserTabResidencySnapshot | null {
    if (!record) return null
    return {
      tabId: record.tabId,
      windowId: record.windowId,
      sessionId: record.sessionId,
      residency: record.residency,
      generation: record.generation,
      lastSelectedAt: record.lastSelectedAt ?? null,
      visible: record.visible === true,
      lastActivityAt: record.lastActivityAt,
    }
  }
  const residency: BrowserTabResidencyCoordinatorPort = {
    upsert: (record) =>
      residencyCoordinator.upsert({
        ...record,
        // generation 由协调器自持(保留已有代数),此处仅满足记录形状。
        generation: 0,
        lastSelectedAt: record.lastSelectedAt ?? undefined,
      }),
    get: (tabId) => toResidencySnapshot(residencyCoordinator.get(tabId)),
    report: (tabId, patch) => residencyCoordinator.report(tabId, patch),
    beginSuspend: (tabId) => toResidencySnapshot(residencyCoordinator.beginSuspend(tabId)),
    commitSuspend: (tabId, generation) => toResidencySnapshot(residencyCoordinator.commitSuspend(tabId, generation)),
    cancelSuspend: (tabId, generation) => toResidencySnapshot(residencyCoordinator.cancelSuspend(tabId, generation)),
    markRestoring: (tabId) => toResidencySnapshot(residencyCoordinator.markRestoring(tabId)),
    completeRestore: (tabId, generation) => residencyCoordinator.completeRestore(tabId, generation),
    failRestore: (tabId, generation) => toResidencySnapshot(residencyCoordinator.failRestore(tabId, generation)),
    markAttached: (tabId, visible, residencyGeneration) => residencyCoordinator.markAttached(tabId, visible, residencyGeneration),
    markDetached: (tabId) => residencyCoordinator.markDetached(tabId),
    remove: (tabId) => residencyCoordinator.remove(tabId),
    whenIdle: () => residencyCoordinator.whenIdle(),
    dispose: () => residencyCoordinator.dispose(),
  }

  /* 截图表面协调器(A8):prepare/release 经 deps.emit 发往窗口;ready 回报由
   * ipc 层接到 runtime.handleScreenshotSurfaceReady。 */
  const screenshotSurface = createDesktopBrowserScreenshotSurfaceCoordinator({
    getWindow: deps.getWindow,
    webContentsFromId: (id) => webContents.fromId(id),
    emit: deps.emit,
    log: deps.log,
    warn: deps.warn,
  })

  /** ZCode 装配点的 CSS 像素归一(nativeImage,无 sharp 依赖,见偏差 2)。 */
  const resizeScreenshotToCssPixels = async (
    base64: string,
    viewport: { width: number; height: number },
  ): Promise<string | undefined> => {
    const image = nativeImage.createFromBuffer(Buffer.from(base64, "base64"))
    if (image.isEmpty()) return undefined
    const resized = image.resize({ width: viewport.width, height: viewport.height, quality: "best" })
    if (resized.isEmpty()) return undefined
    return resized.toPNG().toString("base64")
  }

  /* playwright-over-CDP 引擎端口(A5 会话 + A6 桥)+ locator 端口(A4)。 */
  const playwrightPort = createPlaywrightActionExecutor({ debug: deps.log })
  const locatorPorts: LocatorInputPorts = {
    dispatchClickAt,
    dispatchKey,
    pasteTextIntoFocusedTarget,
    assertFocusedInputTarget,
  }
  const executeCommand: CommandExecutor = (view, command, options) =>
    executeBrowserCommandOnView(
      view,
      // 管理器命令载荷为平铺形状(BrowserGuestCommand);执行器按
      // {method, params} 消费,params 同形状平铺(playwright.action 顶层直通)。
      { ...command, params: { ...command } },
      { ...(options?.signal ? { signal: options.signal } : {}), playwright: playwrightPort },
    )
  const executeLocator: IabPlaywrightLocatorExecutor = async (view, action, timeoutMs, signal) => {
    const outcome = await executeIabPlaywrightLocator(view, action as unknown as LocatorAction, timeoutMs, signal, locatorPorts)
    return outcome.kind === "done" ? { kind: "done", value: outcome.value } : outcome
  }

  /* JS 对话框控制器(A7):sendSync 原生替代 + 自动化直通。 */
  const dialogController = new EmbeddedBrowserJavaScriptDialogController({
    getLocale: () => app.getLocale(),
    warn: deps.warn,
    webContentsFromId: (id) => webContents.fromId(id),
    browserWindowFromId: (id) => BrowserWindow.fromId(id) ?? null,
  })

  const managerDeps: BrowserManagerDeps = {
    log: deps.log,
    warn: deps.warn,
    emit: deps.emit,
    getWindow: deps.getWindow,
    webContentsFromId: (id) => webContents.fromId(id),
    isWebviewType: (contents) => contents.getType() === "webview",
    ...(deps.attachTimeoutMs === undefined ? {} : { attachTimeoutMs: deps.attachTimeoutMs }),
    ...(deps.tabLimit === undefined ? {} : { tabLimit: deps.tabLimit }),
    screenshotSurfaceCoordinator: screenshotSurface,
    resizeScreenshotToCssPixels,
    recording: {
      // A9:Electron WebM 录制器(隐藏渲染窗口 + MessageChannelMain 桥)。
      createRecorder: (options) => createElectronBrowserWebmRecorder(options, deps.log),
      tempRoot: join(deps.configDir, "browser-recordings"),
    },
  }

  const manager = new BrowserGuestManager(managerDeps, {
    residency: { coordinator: residency },
    // 跨重启 tab 恢复:JSON 文件恢复存储(browser-recovery/store.json)。
    recoveryStore: createRecoveryStore(deps.configDir, { warn: deps.warn }),
    executeCommand,
    executeLocator,
    // A6 接线:CDP 对话框开/关 → 控制器的防二次接管标记。
    onDialogOpening: (tabId) => {
      const guestId = manager.tabs.get(tabId)?.guest?.id
      if (guestId !== undefined) dialogController.onDialogOpening(guestId)
    },
    onDialogClosed: (tabId) => {
      const guestId = manager.tabs.get(tabId)?.guest?.id
      if (guestId !== undefined) dialogController.onDialogClosed(guestId)
    },
  })
  managerRef = manager

  /* 空闲挂起调度器:后台 tab 空闲超阈值即发起挂起(E2E/测试可直接 tick 驱动)。 */
  const suspendScheduler: SuspendScheduler = createSuspendScheduler({
    manager,
    getWindow: deps.getWindow,
    warn: deps.warn,
    ...(deps.suspendIdleDelayMs === undefined ? {} : { idleDelayMs: deps.suspendIdleDelayMs }),
  })
  suspendScheduler.start()

  /* Git 面板文件 watch（实时刷新源）：fs.watch 工作区 + .git，60s 防抖后经 deps.emit
   * 回发 lume:browser-git-dirty；工作区路径由 renderer 经 lume:browser-git-watch 告知
   * （main 不感知 projectPath），unwatchAll 随 runtime dispose 生效。 */
  const gitWatcher = createGitWorkspaceWatcher({
    emit: deps.emit,
    getWindow: deps.getWindow,
    warn: deps.warn,
  })

  /** ipc 层(createBrowserIpc deps.manager)消费的委托面。 */
  const view: BrowserViewManagerPort = {
    attachGuest: async (request) =>
      manager.attachGuest(request.tabId, request.webContentsId, {
        windowId: request.windowId,
        ...(request.workspaceKey === undefined ? {} : { workspaceKey: request.workspaceKey }),
        ...(request.remoteSessionId === undefined ? {} : { remoteSessionId: request.remoteSessionId }),
        ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
        ...(request.active === undefined ? {} : { active: request.active }),
        ...(request.residencyGeneration === undefined ? {} : { residencyGeneration: request.residencyGeneration }),
      }),
    detachGuest: (tabId, webContentsId, windowId) => manager.detachGuestBeforeReplacement(tabId, webContentsId, windowId),
    closeTabFromRenderer: (scope) => manager.closeTabFromRenderer(scope),
    reportResidency: (report) =>
      manager.reportResidency({
        tabId: report.tabId,
        windowId: report.windowId,
        workspaceKey: report.workspaceKey,
        sessionId: report.sessionId,
        ...(report.remoteSessionId === undefined ? {} : { remoteSessionId: report.remoteSessionId }),
        ...(report.restoreUrl === null ? {} : { restoreUrl: report.restoreUrl }),
        // title=null 必须透传(renderer 侧标题清空):manager 以此清 cachedTitle,
        // 否则 tab 条残留旧标题(ZCode o.reportBrowserTabResidency 同语义)。
        title: report.title,
        ...(report.faviconUrl === undefined ? {} : { faviconUrl: report.faviconUrl }),
        loading: report.loading,
        selected: report.selected,
        visible: report.visible,
        ...(report.currentTask === undefined ? {} : { currentTask: report.currentTask }),
      }),
    acknowledgeSuspend: async (ack) => manager.acknowledgeSuspend(ack),
    ensureResident: (scope) => manager.ensureResidentFromRenderer(scope),
    restoreTabs: (query) => manager.restoreTabs(query),
    updateViewport: (tabId, viewport, windowId, zoomFactor) =>
      manager.updateViewportFromRenderer(tabId, viewport, windowId, zoomFactor),
  }

  /* 后端描述符:装配期一次生成(id/generation 全进程稳定,ZCode plugin-facade 形状)。 */
  const descriptor: BrowserBackendDescriptor = buildIabDescriptor({
    id: `iab:${randomUUID()}`,
    generation: Date.now(),
  })

  return {
    view,
    manager,
    screenshotSurface,
    dialogController,
    suspendScheduler,
    mountAuthorizer: {
      // 分区强制(ZCode 行为 + Lume 增强位):renderer 声明的分区必须为空或
      // 等于浏览器分区,一律改写为 BROWSER_GUEST_PARTITION;其余拒绝挂载。
      authorizeGuestMount: ({ partition }) => {
        if (partition && partition !== BROWSER_GUEST_PARTITION) return null
        return { partition: BROWSER_GUEST_PARTITION }
      },
    },
    descriptor() {
      return descriptor
    },
    async execute(context, command, signal) {
      // ZCode PCe:自动化直通括弧(eh.beginAutomation)+ 操作事件(zM/z1)。
      const endAutomation = dialogController.beginAutomation(context.windowId)
      const operationTabId = resolveBrowserOperationTabId(command)
      const resetsResizeBaseline = browserOperationResetsResizeBaseline(command)
      if (operationTabId) manager.sendOperationEvent(context, operationTabId, resetsResizeBaseline)
      try {
        const result = await manager.execute(context, command, signal)
        if (!operationTabId) {
          const resultTabId = resolveBrowserOperationTabId(command, result)
          if (resultTabId) manager.sendOperationEvent(context, resultTabId, resetsResizeBaseline)
        }
        return result
      } finally {
        endAutomation()
      }
    },
    attachGuest: (request) => view.attachGuest(request),
    detachGuest: (tabId, webContentsId, windowId) => view.detachGuest(tabId, webContentsId, windowId),
    closeTab: (scope) => view.closeTabFromRenderer(scope),
    reportResidency: (report) => view.reportResidency(report),
    suspendReady: (ack) => view.acknowledgeSuspend(ack),
    ensureResident: (scope) => view.ensureResident(scope),
    restoreTabs: (query) => view.restoreTabs(query),
    updateViewport: (tabId, viewport, windowId, zoomFactor) => view.updateViewport(tabId, viewport, windowId, zoomFactor),
    watchWorkspace: (workspacePath) => gitWatcher.watchWorkspace(workspacePath),
    handleScreenshotSurfaceReady(payload, senderWebContentsId) {
      // 载荷形状由协调器 handleReady 的身份/视口/scale 校验把关。
      screenshotSurface.handleReady(payload as BrowserScreenshotSurfaceReadyPayload, senderWebContentsId)
    },
    handleWindowDestroyed(windowId) {
      screenshotSurface.handleWindowDestroyed(windowId)
    },
    dispose() {
      suspendScheduler.stop()
      gitWatcher.unwatchAll()
      manager.disposeAll()
      void manager.whenRecoveryIdle().catch(() => {})
      screenshotSurface.dispose()
      dialogController.dispose()
    },
  }
}
