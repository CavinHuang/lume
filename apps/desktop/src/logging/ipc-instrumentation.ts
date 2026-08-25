/**
 * lume:invoke / ipcMain.handle 参数结果埋点的核心逻辑。
 *
 * 与 Electron 解耦（quiet 判定与事件发射由调用方注入），便于对
 * completed/failed/quiet-success/quiet-failure 四条路径做单元测试。
 */
import { extractCorrelationIds } from '@lume/shared'

export interface IpcInstrumentDeps {
  isQuiet: (name: string) => boolean
  /** 调用方负责兜底自身异常——埋点故障不得影响 IPC 语义。 */
  emit: (event: IpcCommandEvent) => void
  /** 可注入时钟（单测模拟慢命令）；缺省 performance.now。 */
  now?: () => number
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
  error?: Error
}

/** 超过该耗时的成功命令升为 warn，使其穿透生产 fileLevel=info 的门槛留痕。 */
export const SLOW_IPC_MS = 2_000

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
    // 失败永远记录，quiet 只豁免成功路径。
    deps.emit({
      level: 'warn',
      event: 'command.failed',
      name,
      message: `ipc failed: ${name}`,
      durationMs: Math.round(now() - startedAt),
      args,
      correlation: extractCorrelationIds(args),
      ...(error instanceof Error ? { error } : {}),
    })
    throw error
  }
}
