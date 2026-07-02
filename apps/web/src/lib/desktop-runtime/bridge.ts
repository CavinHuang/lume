export interface DesktopListenerEvent<T> {
  payload: T
}

export interface DesktopDownloadStartedEvent {
  event: 'Started'
  data: {
    contentLength?: number | null
  }
}

export interface DesktopDownloadProgressEvent {
  event: 'Progress'
  data: {
    chunkLength: number
    contentLength?: number | null
  }
}

export interface DesktopDownloadFinishedEvent {
  event: 'Finished'
  data: Record<string, never>
}

export type DesktopDownloadEvent =
  | DesktopDownloadStartedEvent
  | DesktopDownloadProgressEvent
  | DesktopDownloadFinishedEvent

export interface DesktopUpdateHandle {
  currentVersion: string
  version: string
  date?: string
  body?: string
  download(onEvent?: (event: DesktopDownloadEvent) => void): Promise<void>
  install(): Promise<void>
}

export interface DesktopBridgeWindow {
  startDragging?(): Promise<void>
  onDragDropEvent?(
    listener: (payload: unknown) => void
  ): Promise<() => void> | (() => void)
  minimize?(): Promise<void>
  toggleMaximize?(): Promise<void>
  close?(): Promise<void>
  isMaximized?(): Promise<boolean>
  onMaximizeStateChange?(
    listener: (payload: { maximized: boolean }) => void
  ): () => void
}

export interface DesktopBridgeAPI {
  invoke<T>(command: string, payload?: unknown): Promise<T>
  listen<T>(
    channel: string,
    listener: (payload: T) => void
  ): Promise<() => void> | (() => void)
  convertFileSrc?(path: string): string
  relaunch?(): Promise<void>
  checkForUpdate?(): Promise<DesktopUpdateHandle | null>
  window?: DesktopBridgeWindow
}

declare global {
  interface Window {
    electronAPI?: DesktopBridgeAPI
  }
}

export function getDesktopBridge(): DesktopBridgeAPI | null {
  if (typeof window === 'undefined') return null
  return window.electronAPI ?? null
}

export function createDesktopUnavailableError(action: string): Error {
  return new Error(`[desktop] ${action} requires the Electron desktop bridge`)
}

export function filePathToFileUrl(path: string): string {
  if (/^(data:|https?:|file:)/i.test(path)) return path

  const normalized = path.replace(/\\/g, '/')
  const withLeadingSlash = normalized.startsWith('/') ? normalized : `/${normalized}`

  return encodeURI(`file://${withLeadingSlash}`)
}
