/**
 * 驻留协调器(记录 + 裁决)—— 严格 TypeScript 移植。
 *
 * 来源:D:\workspace\projects\ai-projects\lume\.zcode\analysis\extracted\07-residency-coordinator.clean.js
 *       (ZCode Desktop 3.10.1,out/main/index.js @920320-926000)
 *
 * ZCode 原名对照:
 *   kle / isBrowserTabResidencyProtected (@920320) → isResidencyProtected
 *   xH  / selectBrowserTabLimitVictim    (@920326) → selectEvictionVictim
 *   Gg  / BrowserTabResidencyCoordinator (@924341) → BrowserTabResidencyCoordinator(保留原名)
 *
 * 语义偏差:仅变量语义化命名;本模块不含平台频道前缀,逻辑逐行等价。
 *   isResidencyProtected 返回值经 `!!` 归一为 boolean
 *   (源实现全 falsy 时经 || 链返回 undefined,调用处均为真值判断,行为不变)。
 *
 * 状态机:live-visible │ live-background │ suspend-pending │ restoring │ suspended
 *   (record.generation 整数,每次状态跃迁 +1,用于并发/竞态防护)
 *
 * 角色分工:
 *   - 本协调器:只做"记录 + 裁决"(谁可以被挂起/淘汰),不触碰 webview;
 *   - BrowserGuestManager:执行者(收到裁决后发 IPC 给 renderer)。
 */
import type { BrowserResidency } from "./types"

/** 每窗口 tab 上限(超出即淘汰) */
export const TAB_LIMIT = 32

/**
 * 驻留记录(协调器内部态)。
 * 与 types.ts 的 `BrowserResidency` 契约对齐;活动位(visible/selected/…)
 * 缺省视为 false。
 */
export interface ResidencyRecord {
  tabId: string
  windowId: number
  sessionId: string
  residency: BrowserResidency
  /** 状态跃迁代数:每次跃迁 +1,用于并发防护 */
  generation: number
  /** renderer 可见 */
  visible?: boolean
  /** renderer 选中态 */
  selected?: boolean
  /** 同窗口同会话内的首选 tab(report(selected) 时唯一化) */
  preferred?: boolean
  /** guest webview 是否已 attach 回来 */
  guestAttached?: boolean
  /** 有 agent 命令在跑 */
  operationActive?: boolean
  /** 截图/录像在途 */
  captureActive?: boolean
  /** 正在发声 */
  audible?: boolean
  /** 视频播放中 */
  mediaActive?: boolean
  /** 页面加载中 */
  loading?: boolean
  /** 下载未完成 */
  downloadActive?: boolean
  openedAt: number
  lastActivityAt: number
  lastSelectedAt?: number
}

/** renderer/管理器上报的运行态补丁(residency/generation 由协调器派生,不可直接上报) */
export type ResidencyReportPatch = Partial<Omit<ResidencyRecord, "tabId" | "residency" | "generation">>

export interface BrowserTabResidencyCoordinatorOptions {
  /** 每窗口 tab 上限(超出即淘汰),缺省 TAB_LIMIT */
  tabLimit?: number
  /** 时钟注入(测试用),缺省 Date.now */
  now?: () => number
  /** 淘汰裁决回调:返回 false 表示关闭失败,评估循环停止以防死循环 */
  onEvict: (record: ResidencyRecord) => boolean | Promise<boolean>
}

/** 淘汰受害者选择的窗口范围 */
export interface EvictionScope {
  windowId: number
  tabLimit?: number
}

/** report 中视为"活动位"的键:任一从 false 变 true 即刷新 lastActivityAt */
const RESIDENCY_ACTIVITY_KEYS = [
  "operationActive",
  "captureActive",
  "audible",
  "mediaActive",
  "loading",
  "downloadActive",
] as const

/**
 * tab 是否受保护(不可挂起/淘汰)。
 * ZCode 原名 kle / isBrowserTabResidencyProtected (@920320)。
 */
export function isResidencyProtected(record: ResidencyRecord): boolean {
  return !!(
    record.residency === "live-visible" ||
    record.residency === "restoring" ||
    record.residency === "suspend-pending" ||
    record.selected ||
    record.visible ||
    record.operationActive || // 有 agent 命令在跑
    record.captureActive || // 截图/录像在途
    record.audible || // 正在发声
    record.mediaActive || // 视频播放中
    record.loading || // 页面加载中
    record.downloadActive // 下载未完成
  )
}

/**
 * 淘汰受害者选择(每窗口超限时调用)。
 * ZCode 原名 xH / selectBrowserTabLimitVictim (@920326)。
 * @returns 受害记录或 null(不超限/全被保护)
 */
export function selectEvictionVictim(records: readonly ResidencyRecord[], scope: EvictionScope): ResidencyRecord | null {
  const inWindow = records.filter((record) => record.windowId === scope.windowId)
  if (inWindow.length <= (scope.tabLimit ?? TAB_LIMIT)) return null

  const candidates = inWindow.filter((record) => !isResidencyProtected(record))
  // LRU 三级比较,最后按 tabId 字典序保证确定性
  candidates.sort((a, b) => {
    let delta = a.lastActivityAt - b.lastActivityAt
    if (delta !== 0) return delta
    delta = (a.lastSelectedAt ?? Number.NEGATIVE_INFINITY) - (b.lastSelectedAt ?? Number.NEGATIVE_INFINITY)
    if (delta !== 0) return delta
    delta = a.openedAt - b.openedAt
    return delta !== 0 ? delta : a.tabId.localeCompare(b.tabId)
  })
  return candidates[0] ?? null
}

/**
 * 驻留协调器。
 * ZCode 原名 Gg / BrowserTabResidencyCoordinator (@924341)。
 */
export class BrowserTabResidencyCoordinator {
  private readonly options: BrowserTabResidencyCoordinatorOptions
  /** tabId -> 记录(含 generation) */
  private readonly records = new Map<string, ResidencyRecord>()
  /** 待裁决的 windowId */
  private readonly pendingWindows = new Set<number>()
  /** 进行中的裁决 Promise(串行化) */
  private evaluation: Promise<void> | null = null
  private disposed = false

  constructor(options: BrowserTabResidencyCoordinatorOptions) {
    this.options = options
  }

  /** 新增或初始化记录(保留已有 generation) */
  upsert(record: ResidencyRecord): ResidencyRecord {
    const existing = this.records.get(record.tabId)
    const merged: ResidencyRecord = { ...record, generation: existing?.generation ?? 0 }
    this.records.set(record.tabId, merged)
    this.requestEvaluation(merged.windowId)
    return { ...merged }
  }

  get(tabId: string): ResidencyRecord | null {
    const record = this.records.get(tabId)
    return record ? { ...record } : null
  }

  list(): ResidencyRecord[] {
    return [...this.records.values()].map((record) => ({ ...record }))
  }

  /**
   * renderer/管理器上报运行态;核心裁决逻辑:
   *  1) 任何"活动位"从 false 变 true → 刷新 lastActivityAt
   *  2) selected=true → 同窗口同会话其它记录 preferred=false,本记录记 lastSelectedAt
   *  3) suspend-pending 期间活动位又变 true → 取消挂起(generation+1 回 live-*)
   *  4) 非 suspended/restoring/suspend-pending → 按 visible 归位 live-*
   */
  report(tabId: string, patch: ResidencyReportPatch): void {
    const record = this.records.get(tabId)
    if (!record) return

    const now = this.now()
    const becameActive = RESIDENCY_ACTIVITY_KEYS.some(
      (key) => patch[key] === true && record[key] !== true,
    )

    Object.assign(record, patch)

    if (patch.selected === true) {
      for (const other of this.records.values()) {
        if (other.tabId !== record.tabId && other.windowId === record.windowId && other.sessionId === record.sessionId) {
          other.preferred = false
        }
      }
      record.preferred = true
      record.lastSelectedAt = now
      record.lastActivityAt = now
    }
    if (patch.visible === true) record.lastActivityAt = now
    if (becameActive) record.lastActivityAt = now

    // suspend-pending 期间被"救活" → generation+1 取消本次挂起
    if (
      record.residency === "suspend-pending" &&
      (record.selected || record.visible || record.loading || record.operationActive ||
        record.captureActive || record.audible || record.mediaActive || record.downloadActive)
    ) {
      record.generation += 1
      record.residency = record.visible ? "live-visible" : "live-background"
    }
    if (record.residency !== "suspended" && record.residency !== "restoring" && record.residency !== "suspend-pending") {
      record.residency = record.visible ? "live-visible" : "live-background"
    }
    this.requestEvaluation(record.windowId)
  }

  /** suspended → restoring(唯一的恢复入口);非 suspended 状态下是 no-op */
  markRestoring(tabId: string): ResidencyRecord | null {
    const record = this.records.get(tabId)
    if (!record) return null
    if (record.residency !== "suspended") return { ...record }
    record.generation += 1
    record.residency = "restoring"
    record.loading = true
    record.lastActivityAt = this.now()
    this.requestEvaluation(record.windowId)
    return { ...record }
  }

  /** 恢复成功(仅当 generation 匹配且仍是 restoring) */
  completeRestore(tabId: string, generation: number): boolean {
    const record = this.records.get(tabId)
    if (!record || record.generation !== generation || record.residency !== "restoring") return false
    record.loading = false
    record.residency = record.visible ? "live-visible" : "live-background"
    record.lastActivityAt = this.now()
    this.requestEvaluation(record.windowId)
    return true
  }

  /** 恢复失败 → 回 suspended(generation+1,旧 attach 凭证全部作废) */
  failRestore(tabId: string, generation: number): ResidencyRecord | null {
    const record = this.records.get(tabId)
    if (!record || record.generation !== generation || record.residency !== "restoring") return null
    record.generation += 1
    record.loading = false
    record.residency = "suspended"
    record.lastActivityAt = this.now()
    this.requestEvaluation(record.windowId)
    return { ...record }
  }

  /** live-background → suspend-pending(挂起发起唯一入口;可见/其它状态受保护 no-op) */
  beginSuspend(tabId: string): ResidencyRecord | null {
    const record = this.records.get(tabId)
    if (!record || record.residency !== "live-background") return null
    record.generation += 1
    record.residency = "suspend-pending"
    this.requestEvaluation(record.windowId)
    return { ...record }
  }

  /** suspend-pending → suspended(挂起完成;generation 匹配才有效) */
  commitSuspend(tabId: string, generation: number): ResidencyRecord | null {
    const record = this.records.get(tabId)
    if (!record || record.generation !== generation || record.residency !== "suspend-pending") return null
    record.guestAttached = false
    record.loading = false
    record.residency = "suspended"
    record.lastActivityAt = this.now()
    this.requestEvaluation(record.windowId)
    return { ...record }
  }

  /** suspend-pending → live-*(发起方 ack 超时/失败回滚;generation 匹配才有效) */
  cancelSuspend(tabId: string, generation: number): ResidencyRecord | null {
    const record = this.records.get(tabId)
    if (!record || record.generation !== generation || record.residency !== "suspend-pending") return null
    record.loading = false
    record.residency = record.visible ? "live-visible" : "live-background"
    this.requestEvaluation(record.windowId)
    return { ...record }
  }

  /** suspend-pending 被取消后 renderer 未执行 → 直接落 suspended */
  commitCancelledSuspend(tabId: string, generation: number): ResidencyRecord | null {
    const record = this.records.get(tabId)
    if (
      !record || record.generation <= generation ||
      (record.residency !== "live-visible" && record.residency !== "live-background")
    ) {
      return null
    }
    record.loading = false
    record.residency = "suspended"
    record.lastActivityAt = this.now()
    this.requestEvaluation(record.windowId)
    return { ...record }
  }

  /** renderer attach 回来时校验:restoring 态下 residencyGeneration 必须一致 */
  markAttached(tabId: string, visible: boolean, residencyGeneration?: number): boolean {
    const record = this.records.get(tabId)
    if (!record) return false
    if (record.residency === "restoring" && (residencyGeneration === undefined || residencyGeneration !== record.generation)) {
      return false
    }
    record.guestAttached = true
    record.visible = visible
    if (record.residency !== "restoring") record.residency = visible ? "live-visible" : "live-background"
    record.lastActivityAt = this.now()
    this.requestEvaluation(record.windowId)
    return true
  }

  markDetached(tabId: string): void {
    const record = this.records.get(tabId)
    if (record) {
      record.guestAttached = false
      this.requestEvaluation(record.windowId)
    }
  }

  /** 跃迁校验(generation + 期望状态都匹配才有效) */
  isTransitionCurrent(tabId: string, generation: number, expectedResidency: BrowserResidency): boolean {
    const record = this.records.get(tabId)
    return !!(record && record.generation === generation && record.residency === expectedResidency)
  }

  remove(tabId: string): void {
    const record = this.records.get(tabId)
    if (record) {
      this.records.delete(tabId)
      this.requestEvaluation(record.windowId)
    }
  }

  /** 等待在途裁决排空(report 调用方收尾用) */
  async whenIdle(): Promise<void> {
    await this.evaluation
  }

  dispose(): void {
    this.disposed = true
    this.pendingWindows.clear()
    this.records.clear()
  }

  /** 裁决调度:按窗口串行,微任务级合并(pendingWindows 去重) */
  requestEvaluation(windowId: number): void {
    if (this.disposed) return
    this.pendingWindows.add(windowId)
    if (!this.evaluation) {
      this.evaluation = Promise.resolve()
        .then(() => this.evaluatePendingWindows())
        .finally(() => {
          this.evaluation = null
          if (this.pendingWindows.size > 0) {
            const next = this.pendingWindows.values().next().value
            if (next !== undefined) this.requestEvaluation(next)
          }
        })
    }
  }

  /** 逐窗口淘汰循环:直到该窗口不超限或受害者全部淘汰失败 */
  async evaluatePendingWindows(): Promise<void> {
    while (!this.disposed && this.pendingWindows.size > 0) {
      const windowId: number = this.pendingWindows.values().next().value
      this.pendingWindows.delete(windowId)
      for (;;) {
        if (this.disposed) break
        const victim = selectEvictionVictim([...this.records.values()], {
          windowId,
          tabLimit: this.options.tabLimit ?? TAB_LIMIT,
        })
        if (!victim) break
        const record = this.records.get(victim.tabId)
        if (!record) continue
        // onEvict 返回 false(关闭失败)则停止,防止死循环
        if (!(await this.options.onEvict({ ...record }))) break
        this.remove(record.tabId)
      }
    }
  }

  now(): number {
    return this.options.now?.() ?? Date.now()
  }
}
