/**
 * lume:invoke / ipcMain.handle 参数结果埋点的核心逻辑。
 *
 * 与 Electron 解耦（quiet 判定与事件发射由调用方注入），便于对
 * completed/failed/quiet-success/quiet-failure 四条路径做单元测试。
 */
import { extractCorrelationIds, normalizeLogValue } from '@lume/shared'
// 复用通用限流器（electron-free 纯模块），避免再造一份窗口计数逻辑。
import { createEventRateLimiter } from '../tray-window-runtime'

/** command.failed 埋点限流窗口：防受陷 renderer 刷失败制造日志洪水（文件队列有 cap 兜底）。 */
const FAILURE_RATE_WINDOW_MS = 10_000

export interface IpcInstrumentDeps {
  isQuiet: (name: string) => boolean
  /** 调用方负责兜底自身异常——埋点故障不得影响 IPC 语义。 */
  emit: (event: IpcCommandEvent) => void
  /** 可注入时钟（单测模拟慢命令）；缺省 performance.now。 */
  now?: () => number
  /** failed 埋点限流（缺省：模块级窗口内按命令名放行首条）；测试可注入。 */
  recordFailure?: (name: string) => { allowed: boolean; suppressedCount: number }
}

export interface IpcCommandEvent {
  level: 'debug' | 'warn'
  event: 'command.completed' | 'command.failed'
  name: string
  message: string
  durationMs: number
  args: unknown
  correlation: Record<string, string>
  result?: unknown
  /** Error 原样携带；非 Error 抛出值经 normalizeLogValue 归一化后仍保留详情。 */
  error?: unknown
  /** 因限流被压制的同命令失败条数（本次放行时回填）。 */
  suppressedCount?: number
}

/** 超过该耗时的成功命令升为 warn，使其穿透生产 fileLevel=info 的门槛留痕。 */
export const SLOW_IPC_MS = 2_000

const defaultFailureRateLimiter = createEventRateLimiter({ windowMs: FAILURE_RATE_WINDOW_MS })

export async function instrumentIpcCommand<T>(
  deps: IpcInstrumentDeps,
  name: string,
  args: unknown,
  run: () => Promise<T> | T,
): Promise<T> {
  const now = deps.now ?? (() => performance.now())
  const quiet = deps.isQuiet(name)
  const startedAt = now()
  try {
    const result = await run()
    if (quiet) return result
    const durationMs = Math.round(now() - startedAt)
    deps.emit({
      level: durationMs >= SLOW_IPC_MS ? 'warn' : 'debug',
      event: 'command.completed',
      name,
      message: `ipc completed: ${name}`,
      durationMs,
      args,
      correlation: extractCorrelationIds(args),
      result,
    })
    return result
  } catch (error) {
    // 失败永远记录，quiet 只豁免成功路径；但按命令名限流压制洪水（IPC 语义不受影响，照常 rethrow）。
    const decision = deps.recordFailure?.(name) ?? defaultFailureRateLimiter.record(name)
    if (!decision.allowed) throw error
    deps.emit({
      level: 'warn',
      event: 'command.failed',
      name,
      message: `ipc failed: ${name}`,
      durationMs: Math.round(now() - startedAt),
      args,
      correlation: extractCorrelationIds(args),
      ...(error instanceof Error ? { error } : { error: normalizeLogValue(error) }),
      ...(decision.suppressedCount > 0 ? { suppressedCount: decision.suppressedCount } : {}),
    })
    throw error
  }
}
