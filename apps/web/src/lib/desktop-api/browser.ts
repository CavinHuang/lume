import { invoke } from '@/lib/desktop-runtime/core'
import { listen } from '@/lib/desktop-runtime/event'
import type {
  BrowserRequestContext,
  BrowserSettings,
  BrowserTabDescriptor,
} from '@lume/shared'

export type BrowserRuntimeMethod =
  | 'handshake' | 'list' | 'ensure' | 'close' | 'bounds' | 'visible' | 'focus'
  | 'navigate' | 'back' | 'forward' | 'reload' | 'snapshot' | 'screenshot' | 'screenshot:save'
  | 'click' | 'doubleClick' | 'fill' | 'type' | 'press' | 'scroll' | 'drag' | 'share' | 'unshare' | 'claim'
  | 'url' | 'title' | 'cdp' | 'openExternal' | 'settings:get' | 'settings:update'
  | 'openPopup' | 'vault:summary' | 'vault:list-passwords' | 'vault:delete-password'
  | 'contacts:list' | 'contacts:upsert' | 'contacts:delete' | 'browserAuth:list' | 'browserAuth' | 'contactFill'
  | 'downloads:list' | 'downloads:clear' | 'clear-data'
  | 'find' | 'find:stop' | 'zoom:get' | 'zoom:set' | 'emulate'
  | 'dialog:handle'
  | 'upload'

export function browserRuntime<T = unknown>(input: {
  method: BrowserRuntimeMethod
  context?: BrowserRequestContext
  params?: Record<string, unknown>
  requestId?: string
  idempotencyKey?: string
}): Promise<T> {
  return invoke<T>('browser_runtime', {
    method: input.method,
    context: input.context ?? { browserSessionId: 'renderer', browserTurnId: 'renderer', actor: 'user' },
    params: input.params ?? {},
    ...(input.requestId ? { requestId: input.requestId } : {}),
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
  })
}

export const getBrowserSettings = () => invoke<BrowserSettings>('browser_settings:get')
export const updateBrowserSettings = (input: Partial<BrowserSettings>) => invoke<BrowserSettings>('browser_settings:update', input)
export const discoverChromeProfiles = () => invoke<Array<{ id: string; name: string; platform: 'win32' | 'darwin'; hasCookies: boolean; hasPasswords: boolean }>>('browser_import:discover')
export const startChromeImport = (input: { profileId: string; cookies: boolean; passwords: boolean; acknowledged: boolean }) => invoke<{ jobId: string }>('browser_import:start', input)
export const cancelChromeImport = (jobId: string) => invoke<{ ok: true }>('browser_import:cancel', { jobId })

export async function onBrowserEvent(listener: (event: { method: string; params: Record<string, unknown> }) => void) {
  return listen<{ method: string; params: Record<string, unknown> }>('browser:event', ({ payload }) => listener(payload))
}

export type { BrowserSettings, BrowserTabDescriptor }
