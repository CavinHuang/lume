/**
 * 右侧面板「终端」tab 的 IPC 契约类型。
 *
 * 链路（对齐 git-panel.ts 的单源约定）：
 *   renderer --invoke(lume:terminal-*)--> desktop main --fork RPC(terminal:*)--> sidecar
 *   sidecar --notification(terminal:data)--> desktop main --lume:event--> renderer
 *
 * 消费方：
 *  - apps/sidecar/src/services/terminal/terminal-service.ts（PTY 执行体，MVP 为
 *    child_process.spawn 管道，见该文件头「node-pty 升级路径」）
 *  - apps/desktop/src/browser/terminal-bridge.ts（main 中继）
 *  - apps/web/src/lib/desktop-api/terminal.ts + components/terminal/TerminalPanel.tsx
 * 通道名经 apps/desktop/src/renderer-ipc-contract.ts 白名单放行。必须保持零依赖纯 TS。
 */

/** renderer→main invoke 通道名（lume:invoke 漏斗直发，main dispatchCommand 前缀转发）。 */
export const TERMINAL_IPC_CHANNELS = {
  create: 'lume:terminal-create',
  write: 'lume:terminal-write',
  resize: 'lume:terminal-resize',
  dispose: 'lume:terminal-dispose',
  /** main→renderer 事件（sidecar terminal:data 通知中继）。 */
  data: 'lume:terminal-data',
} as const

/** sidecar fork RPC 方法名（main→sidecar；与 renderer 通道名解耦）。 */
export const TERMINAL_SIDECAR_METHODS = {
  create: 'terminal:create',
  write: 'terminal:write',
  resize: 'terminal:resize',
  dispose: 'terminal:dispose',
  /** sidecar→main 输出通知。 */
  data: 'terminal:data',
} as const

/** create 入参：cwd 缺省时 sidecar 回落到用户主目录；cols/rows 供 PTY 记录尺寸。 */
export interface TerminalCreateInput {
  cwd?: string | null
  cols?: number
  rows?: number
}

/** create 结果：id 用于后续 write/resize/dispose/data 关联；shell 为探测到的可执行文件。 */
export interface TerminalCreateResult {
  id: string
  shell: string
}

/** write 入参：data 为发往 shell stdin 的原始字节（UTF-8 文本）。 */
export interface TerminalWriteInput {
  id: string
  data: string
}

/** resize 入参（列/行数；MVP 管道模式仅记录，PTY 升级后生效）。 */
export interface TerminalResizeInput {
  id: string
  cols: number
  rows: number
}

/** dispose 入参。 */
export interface TerminalDisposeInput {
  id: string
}

/** data 事件载荷：一次批量 flush 的输出块（UTF-8 文本，含 ANSI 转义序列）。 */
export interface TerminalDataEvent {
  id: string
  data: string
}
