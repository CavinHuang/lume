/**
 * 空闲挂起调度器 —— 挂起发起的决策层(ZCode 中位于提取域外的常驻挂起发起装配段)。
 *
 * 职责:周期性枚举管理器的挂起裁决视图(manager.listSuspendViews),选出
 *   (a) 常驻为 live-background(已挂起/挂起中/恢复中/可见一律跳过),
 *   (b) renderer 未展示(visible=false),
 *   (c) 无运行态保护(busy=false:选中/加载/媒体/agent 命令/截图录像/下载),
 *   (d) 空闲超过 idleDelayMs(以 residency 记录的 lastActivityAt 为基准;
 *       无 residency 记录的 tab 不会出现在视图中 —— 无法裁决也不可挂起),
 *   (e) 未命中注入的 isProtected 额外保护,
 * 的候选,逐个交 manager.suspendTabForIdle 发起挂起飞行:
 *   suspend-pending → lume:browser-view-suspend(renderer 卸载 webview 空壳)
 *   → suspend-ready ack → 关 guest → suspended。
 *
 * 装配:assemble.ts 创建并 start();runtime.dispose() 中 stop()。
 * 决策核心 selectIdleSuspendCandidates 为纯函数,单测锚点。
 */
import type { BrowserWindow } from "electron"
import type { BrowserGuestManager, TabSuspendView } from "./guest-manager"

/** 空闲判定阈值缺省:5 分钟 */
const DEFAULT_IDLE_DELAY_MS = 5 * 60 * 1000
/** 轮询周期缺省:60 秒 */
const DEFAULT_POLL_INTERVAL_MS = 60 * 1000

/** 调度器选项 */
export interface SuspendSchedulerOptions {
  manager: BrowserGuestManager
  /** 宿主窗口;不存在/已销毁时 tick 空转(关窗/退出的 tab 清理由管理器自理) */
  getWindow: () => BrowserWindow | null
  /** 空闲判定阈值,缺省 5 分钟 */
  idleDelayMs?: number
  /** 轮询周期,缺省 60 秒 */
  pollIntervalMs?: number
  /** 额外保护谓词(返回 true 跳过;业务自定义保护,如 handoff tab) */
  isProtected?: (view: TabSuspendView) => boolean
  warn?: (message: string, error?: unknown) => void
}

/** 调度器句柄:tick 独立暴露(测试/E2E 手动触发) */
export interface SuspendScheduler {
  start(): void
  stop(): void
  /** 执行一轮裁决并逐个发起挂起;返回本轮选中的候选 tabId(发起可能失败) */
  tick(): Promise<string[]>
}

/**
 * 单轮挂起裁决(纯函数):保持输入顺序返回应挂起的 tabId 集合。
 * 判定:live-background 且不可见、不忙、未命中 isProtected、空闲 ≥ idleDelayMs。
 */
export function selectIdleSuspendCandidates(
  views: readonly TabSuspendView[],
  options: {
    idleDelayMs: number
    now: number
    isProtected?: (view: TabSuspendView) => boolean
  },
): string[] {
  return views
    .filter(view =>
      view.residency === "live-background" &&
      !view.visible &&
      !view.busy &&
      !(options.isProtected?.(view) ?? false) &&
      options.now - view.lastActivityAt >= options.idleDelayMs,
    )
    .map(view => view.tabId)
}

/** 创建空闲挂起调度器(start 前不轮询;tick 可重入保护:进行中的轮次直接跳过) */
export function createSuspendScheduler(options: SuspendSchedulerOptions): SuspendScheduler {
  const idleDelayMs = options.idleDelayMs ?? DEFAULT_IDLE_DELAY_MS
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  let timer: ReturnType<typeof setInterval> | null = null
  let ticking = false

  async function tick(): Promise<string[]> {
    if (ticking) return []
    const win = options.getWindow()
    if (!win || win.isDestroyed()) return []
    ticking = true
    try {
      const candidates = selectIdleSuspendCandidates(options.manager.listSuspendViews(), {
        idleDelayMs,
        now: Date.now(),
        ...(options.isProtected ? { isProtected: options.isProtected } : {}),
      })
      for (const tabId of candidates) {
        try {
          await options.manager.suspendTabForIdle(tabId)
        } catch (error) {
          options.warn?.(`[browser-suspend] idle suspend failed tabId=${tabId}`, error)
        }
      }
      return candidates
    } finally {
      ticking = false
    }
  }

  return {
    start() {
      if (timer) return
      timer = setInterval(() => {
        void tick()
      }, pollIntervalMs)
    },
    stop() {
      if (!timer) return
      clearInterval(timer)
      timer = null
    },
    tick,
  }
}
