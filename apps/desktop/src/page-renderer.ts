import { BrowserWindow } from 'electron'
import { createSecureWebPreferences } from './electron-security'
import { attachWebContentsSecurity } from './main'

export interface RenderUrlOptions {
  timeoutMs?: number
  waitForSelector?: string
}

export interface RenderUrlResult {
  html: string
  finalUrl: string
  status?: number
}

const DEFAULT_TIMEOUT_MS = 45_000

/**
 * Renders a URL in a hidden BrowserWindow and returns post-JS serialized HTML
 * (document.documentElement.outerHTML). A single shared window is reused across
 * renders, and render requests are serialized via a queue (one render at a time)
 * so concurrent callers never race on the shared webContents.
 */
export class PageRenderer {
  private win: BrowserWindow | null = null
  // Serial queue: each render awaits the previous one. The chain is advanced
  // regardless of success/failure so a failing render never drops the queue.
  private chain: Promise<unknown> = Promise.resolve()
  // Origin of the URL currently being rendered; captured per-render and read by
  // the allowNavigation callback. Safe to mutate because renders are serialized.
  private allowedOrigin: string | null = null

  private ensureWindow(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win
    const win = new BrowserWindow({
      show: false,
      // Isolate render cookies/storage from the main window session via an
      // in-memory partition (NOT persist:).
      webPreferences: { ...createSecureWebPreferences(), partition: 'render' },
    })
    // The hidden snapshot window may follow same-origin redirects to reach the
    // finalUrl; navigation is restricted to the requested URL's origin and
    // http/https only. New windows are denied and all permission requests are
    // rejected by attachWebContentsSecurity.
    attachWebContentsSecurity(win, {
      allowNavigation: (url: string) => {
        try {
          const parsed = new URL(url)
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
          return this.allowedOrigin !== null && parsed.origin === this.allowedOrigin
        } catch {
          return false
        }
      },
    })
    // A crashed hidden renderer must not be reused; destroy + null so the next
    // render recreates the window.
    win.webContents.on('render-process-gone', () => {
      if (!win.isDestroyed()) win.destroy()
      this.win = null
    })
    win.on('closed', () => {
      this.win = null
    })
    this.win = win
    return win
  }

  /** Serialize render requests one at a time; failures do not break the chain. */
  renderUrl(url: string, options: RenderUrlOptions = {}): Promise<RenderUrlResult> {
    const run = this.chain.then(() => this.doRender(url, options))
    this.chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private async doRender(url: string, options: RenderUrlOptions): Promise<RenderUrlResult> {
    // Capture the requested URL's origin for the allowNavigation check.
    try { this.allowedOrigin = new URL(url).origin } catch { this.allowedOrigin = null }
    const win = this.ensureWindow()
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

    await this.withTimeout(
      win.webContents.loadURL(url),
      timeoutMs,
      'render_load_timeout',
    )

    await this.waitForReady(win, options.waitForSelector, timeoutMs)

    const serialize = `(() => ({ html: document.documentElement.outerHTML, url: location.href }))()`
    const result = (await this.withTimeout(
      win.webContents.executeJavaScript(serialize),
      timeoutMs,
      'render_exec_timeout',
    )) as { html: string; url: string }

    return { html: result.html, finalUrl: result.url }
  }

  /** Poll readyState === 'complete' (and optional selector) up to a 5s cap after load. */
  private async waitForReady(win: BrowserWindow, selector: string | undefined, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    const cap = Math.min(timeoutMs, 5_000)
    const start = Date.now()
    const selectorCheck = selector ? `!!document.querySelector(${JSON.stringify(selector)})` : 'true'
    while (Date.now() - start < cap && Date.now() < deadline) {
      try {
        const ok = (await win.webContents.executeJavaScript(
          `(() => document.readyState === 'complete' && ${selectorCheck})()`,
        )) as boolean
        if (ok) return
      } catch {
        /* ignore transient poll errors */
      }
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
  }

  /** Race a promise against a timeout; the timer is always cleared on settle. */
  private withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), timeoutMs)
    })
    return Promise.race([promise, timeout]).finally(() => {
      if (timer) clearTimeout(timer)
    })
  }

  async dispose(): Promise<void> {
    if (this.win && !this.win.isDestroyed()) {
      this.win.destroy()
    }
    this.win = null
  }
}
