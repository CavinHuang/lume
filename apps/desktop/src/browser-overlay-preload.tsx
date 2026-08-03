import { createRoot } from 'react-dom/client'
import { ipcRenderer } from 'electron'
import { AnnotationOverlay } from './browser-overlay/AnnotationOverlay'
import { createGuestBridge } from './browser-overlay/guest-state'
import { overlayStyles } from './browser-overlay/overlay.css'

const bootstrapUrl = window.location.href
if (bootstrapUrl.startsWith('about:blank#lume-browser-mount=')) {
  ipcRenderer.send('lume:browser-guest-mounted', bootstrapUrl)
}

function start(): void {
  if (document.querySelector('div[data-lume-annotation-overlay]')) return
  const host = document.createElement('div')
  host.setAttribute('data-lume-annotation-overlay', '')
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none;contain:layout style;'
  const shadow = host.attachShadow({ mode: 'closed' })
  const style = document.createElement('style')
  style.textContent = overlayStyles
  shadow.append(style)
  document.documentElement.append(host)
  const bridge = createGuestBridge()
  createRoot(shadow).render(<AnnotationOverlay bridge={bridge} host={host} />)
}

if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', start, { once: true })
else start()

export {}
