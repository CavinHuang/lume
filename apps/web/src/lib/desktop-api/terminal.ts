/**
 * 终端面板 IPC 封装 —— `lume:terminal-*` 通道的 renderer 侧最小类型化包装。
 *
 * 走应用既有通用通道（desktop-runtime 的 invoke/listen 漏斗，经 sandbox preload
 * 的 `lume:invoke`/`lume:event:*` 白名单）；不新增 preload 面。通道名与类型单源在
 * `@lume/shared`（types/terminal.ts），main 侧中继为
 * apps/desktop/src/browser/terminal-bridge.ts，PTY 执行体在 sidecar
 * services/terminal/terminal-service.ts。
 */
import { invoke } from '@/lib/desktop-runtime/core'
import { listen } from '@/lib/desktop-runtime/event'
import {
  TERMINAL_IPC_CHANNELS,
  type TerminalCreateInput,
  type TerminalCreateResult,
  type TerminalDataEvent,
  type TerminalDisposeInput,
  type TerminalResizeInput,
  type TerminalWriteInput,
} from '@lume/shared'

/** 创建终端会话（sidecar 侧 spawn shell），返回会话 id 与探测到的 shell。 */
export async function createTerminalSession(input: TerminalCreateInput): Promise<TerminalCreateResult> {
  return invoke<TerminalCreateResult>(TERMINAL_IPC_CHANNELS.create, input)
}

/** 向 shell stdin 写入原始数据（单行输入模式：内容 + 换行）。 */
export async function writeTerminal(input: TerminalWriteInput): Promise<void> {
  await invoke(TERMINAL_IPC_CHANNELS.write, input)
}

/** 上报面板尺寸（列/行；MVP 管道模式仅 sidecar 记录，node-pty 升级后生效）。 */
export async function resizeTerminal(input: TerminalResizeInput): Promise<void> {
  await invoke(TERMINAL_IPC_CHANNELS.resize, input)
}

/** 关闭会话并回收 shell 进程。 */
export async function disposeTerminal(input: TerminalDisposeInput): Promise<void> {
  await invoke(TERMINAL_IPC_CHANNELS.dispose, input)
}

/** 订阅终端输出块（main 侧按会话 id 广播；订阅方自行按 id 过滤）。 */
export function onTerminalData(listener: (event: TerminalDataEvent) => void): () => void {
  let active = true
  let dispose: (() => void) | null = null
  void listen<TerminalDataEvent>(TERMINAL_IPC_CHANNELS.data, (e) => {
    if (active) listener(e.payload)
  }).then((unlisten) => {
    if (active) dispose = unlisten
    else unlisten()
  })
  return () => {
    active = false
    dispose?.()
  }
}
