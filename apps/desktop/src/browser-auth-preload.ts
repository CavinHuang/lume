import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('lumeBrowserAuth', {
  submit(input: { selectedOption?: string; values: Record<string, string> }): void {
    if (!input || typeof input !== 'object' || !input.values || typeof input.values !== 'object') return
    ipcRenderer.send('lume:browser-auth', input)
  },
  cancel(): void { ipcRenderer.send('lume:browser-auth', { cancel: true }) },
})
