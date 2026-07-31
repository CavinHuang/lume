import { contextBridge, ipcRenderer } from 'electron'

type BrowserOverlayMessage =
  | { type: 'draft'; body: string }
  | { type: 'preview'; styles: Record<string, string> }
  | { type: 'reset' }
  | { type: 'submit'; body?: string; styles?: Record<string, string> }
  | { type: 'cancel' }

contextBridge.exposeInMainWorld('lumeBrowserOverlay', {
  emit(message: BrowserOverlayMessage): void {
    if (!message || typeof message !== 'object') return
    ipcRenderer.send('lume:browser-overlay', message)
  },
})
