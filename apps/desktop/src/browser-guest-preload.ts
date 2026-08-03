import { ipcRenderer } from 'electron'

// The isolated preload reports the one-time bootstrap URL to main before the
// page runs. Nothing is exposed to the page's main world.
const bootstrapUrl = window.location.href
if (bootstrapUrl.startsWith('about:blank#lume-browser-mount=')) {
  ipcRenderer.send('lume:browser-guest-mounted', bootstrapUrl)
}
