import { contextBridge, ipcRenderer } from 'electron'

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('boot-root')?.remove()
  document.documentElement.style.background = 'transparent'
  document.body.style.background = 'transparent'
}, { once: true })
import { isBrowserAnnotationPopupCommand } from './browser-annotation-security'

type PopupState = {
  sessionId: string
  annotationId?: string
  body: string
  target: string
  mode: 'add' | 'edit'
  canDelete: boolean
}

let currentState: PopupState | undefined
const stateListeners = new Set<(state: PopupState) => void>()

ipcRenderer.on('lume:browser-annotation-popup-state', (_event, payload: unknown) => {
  const state = sanitizePopupState(payload)
  if (!state) return
  currentState = state
  stateListeners.forEach((listener) => listener(state))
})

contextBridge.exposeInMainWorld('lumeBrowserAnnotation', {
  onState(listener: (state: PopupState) => void) {
    stateListeners.add(listener)
    if (currentState) queueMicrotask(() => currentState && stateListeners.has(listener) && listener(currentState))
    return () => stateListeners.delete(listener)
  },
  command(command: string, body?: string) {
    if (!isBrowserAnnotationPopupCommand(command)) return Promise.reject(new Error('unsupported annotation popup command'))
    return ipcRenderer.invoke('lume:browser-annotation-popup', { command, body: typeof body === 'string' ? body.slice(0, 20_000) : undefined })
  },
})

function sanitizePopupState(payload: unknown): PopupState | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const value = payload as Partial<PopupState>
  if (typeof value.sessionId !== 'string' || value.sessionId.length > 512 || typeof value.body !== 'string' || value.body.length > 20_000 || typeof value.target !== 'string' || value.target.length > 512 || (value.mode !== 'add' && value.mode !== 'edit') || typeof value.canDelete !== 'boolean') return undefined
  return { sessionId: value.sessionId, ...(typeof value.annotationId === 'string' && value.annotationId.length <= 256 ? { annotationId: value.annotationId } : {}), body: value.body, target: value.target, mode: value.mode, canDelete: value.canDelete }
}
