export type LumeBootPhase = 'awaken' | 'organize' | 'memory' | 'ready'

export interface BootPhaseCopy {
  status: string
  title: string
  subtitle: string
}

/**
 * 启动序列时长（ms）。唤醒、整理为定时过渡；记忆为等待后端的「resting」循环态。
 * 就绪停留/淡出由 useBootScreen 按 ready 触发。
 */
export const BOOT_TIMINGS = {
  awakenMs: 1800,
  organizeMs: 3000,
  readyHoldMs: 500,
  fadeMs: 300,
  hintThresholdMs: 5000,
} as const

export const PHASE_COPY: Record<LumeBootPhase, BootPhaseCopy> = {
  awaken: {
    status: '正在唤醒',
    title: '正在唤醒 Lume',
    subtitle: '像轻轻睁开眼睛一样，让启动更安静，也更有陪伴感。',
  },
  organize: {
    status: '正在整理',
    title: '正在整理你的工作现场',
    subtitle: '最近窗口、会话与工作上下文，正在被轻轻整理到位。',
  },
  memory: {
    status: '正在连接记忆',
    title: '正在连接记忆与当前窗口',
    subtitle: '历史记忆与此刻的桌面上下文，正在一点点重新连上。',
  },
  ready: {
    status: '准备好了',
    title: '准备好了',
    subtitle: '一切已就绪，正在进入主界面。',
  },
}

export const BOOT_HINT = '首次启动或本地数据较多时，可能需要多等几秒。'

/**
 * 由就绪状态与已耗时解析当前可见阶段。
 * - ready 为真时恒为 'ready'（与耗时无关）。
 * - 否则：唤醒 → 整理 → 记忆（记忆态循环直到 ready）。
 */
export function resolveBootPhase(ready: boolean, elapsedMs: number): LumeBootPhase {
  if (ready) return 'ready'
  if (elapsedMs < BOOT_TIMINGS.awakenMs) return 'awaken'
  if (elapsedMs < BOOT_TIMINGS.awakenMs + BOOT_TIMINGS.organizeMs) return 'organize'
  return 'memory'
}

/** 仅在等待且超过阈值时显示「慢启动」提示。 */
export function shouldShowHint(ready: boolean, elapsedMs: number): boolean {
  return !ready && elapsedMs >= BOOT_TIMINGS.hintThresholdMs
}
