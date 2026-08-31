/**
 * 终端面板 main 中继 —— renderer ↔ main ↔ sidecar 的纯转发层。
 *
 * 职责只有两件事（不缓存会话、不解析输出，PTY 权威在 sidecar
 * apps/sidecar/src/services/terminal/terminal-service.ts）：
 *  1. renderer invoke（lume:terminal-create/write/resize/dispose）→ sidecar
 *     fork RPC（terminal:create/write/resize/dispose），create 透传 {id, shell}；
 *  2. sidecar terminal:data / terminal:exit 通知 → main→renderer 事件
 *     lume:terminal-data / lume:terminal-exit（输出块可能高频，不经通用
 *     sidecar:event 总线，避免唤醒无关订阅者）。
 *
 * 载荷校验在 sidecar 桥（zod）承担；本层只做形状防御，坏载荷静默丢弃。
 */
import {
  TERMINAL_IPC_CHANNELS,
  TERMINAL_SIDECAR_METHODS,
  type TerminalDataEvent,
  type TerminalExitEvent,
} from '@lume/shared'

export interface TerminalRelayOptions {
  /** desktop main → sidecar 的通用 fork RPC（main.ts sidecarHost.call）。 */
  callSidecar: <T>(method: string, params?: unknown) => Promise<T>
  /** main → renderer 事件出口（main.ts emitRendererEvent，preload 同名白名单）。 */
  emitEvent: (channel: string, payload: unknown) => void
}

export interface TerminalRelay {
  /** dispatchCommand 前缀转发入口；返回值经 lume:invoke envelope 送达 renderer。 */
  handleRendererCommand(command: string, payload: Record<string, unknown>): Promise<unknown>
  /** sidecar 通知拦截：terminal:data 返回 true（已消费），其余 false 交还通用路径。 */
  handleSidecarNotification(method: string, params: unknown): boolean
}

export function createTerminalRelay(options: TerminalRelayOptions): TerminalRelay {
  return {
    async handleRendererCommand(command, payload) {
      switch (command) {
        case TERMINAL_IPC_CHANNELS.create:
          return options.callSidecar(TERMINAL_SIDECAR_METHODS.create, payload)
        case TERMINAL_IPC_CHANNELS.write:
          await options.callSidecar(TERMINAL_SIDECAR_METHODS.write, payload)
          return { ok: true }
        case TERMINAL_IPC_CHANNELS.resize:
          await options.callSidecar(TERMINAL_SIDECAR_METHODS.resize, payload)
          return { ok: true }
        case TERMINAL_IPC_CHANNELS.dispose:
          await options.callSidecar(TERMINAL_SIDECAR_METHODS.dispose, payload)
          return { ok: true }
        default:
          throw new Error(`unsupported terminal command: ${command}`)
      }
    },

    handleSidecarNotification(method, params) {
      if (method === TERMINAL_SIDECAR_METHODS.data) {
        const event = params as TerminalDataEvent | null
        if (!event || typeof event.id !== 'string' || typeof event.data !== 'string') return true
        options.emitEvent(TERMINAL_IPC_CHANNELS.data, event)
        return true
      }
      if (method === TERMINAL_SIDECAR_METHODS.exit) {
        const event = params as TerminalExitEvent | null
        if (!event || typeof event.id !== 'string') return true
        const exitCode = typeof event.exitCode === 'number' ? event.exitCode : null
        options.emitEvent(TERMINAL_IPC_CHANNELS.exit, { id: event.id, exitCode })
        return true
      }
      return false
    },
  }
}
