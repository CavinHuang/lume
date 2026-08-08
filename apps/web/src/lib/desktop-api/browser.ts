import { invoke } from '@/lib/desktop-runtime/core'
import { listen } from '@/lib/desktop-runtime/event'
import { sidecarCall } from './system'
import type {
  BrowserReferenceCandidate,
  BrowserReferenceGrantInput,
  BrowserReferenceGrantResult,
  BrowserRequestContext,
  BrowserSettings,
  BrowserTabDescriptor,
} from '@lume/shared'

export type BrowserRuntimeMethod =
  | 'handshake' | 'list' | 'ensure' | 'close' | 'bounds' | 'visible' | 'focus' | 'move-owner' | 'mount:prepare' | 'mount:release'
  | 'navigate' | 'back' | 'forward' | 'reload' | 'stop' | 'hardReload' | 'snapshot' | 'content' | 'screenshot' | 'screenshot:save' | 'screenshot:attachment' | 'screenshot:attachment:delete' | 'screenshot:clipboard'
  | 'wait:load' | 'scroll:get' | 'scroll:set'
  | 'click' | 'doubleClick' | 'fill' | 'type' | 'press' | 'scroll' | 'drag' | 'share' | 'unshare' | 'claim'
  | 'url' | 'title' | 'cdp' | 'openExternal' | 'settings:get' | 'settings:update'
  | 'openPopup' | 'vault:summary' | 'vault:list-passwords' | 'vault:delete-password'
  | 'contacts:list' | 'contacts:upsert' | 'contacts:delete' | 'contactFill'
  | 'downloads:list' | 'downloads:clear' | 'clear-data'
  | 'history:list' | 'history:delete' | 'history:clear'
  | 'extensions:list' | 'extensions:install' | 'extensions:remove' | 'extensions:set-enabled'
  | 'find' | 'find:stop' | 'zoom:get' | 'zoom:set' | 'emulate' | 'viewport:set' | 'viewport:reset' | 'viewport:commit'
  | 'print' | 'devtools' | 'view-source' | 'site-info' | 'tweaks:start' | 'tweaks:apply' | 'tweaks:reset'
  | 'annotation:session' | 'annotation:mode' | 'annotation:delete' | 'annotation:clear' | 'annotation:migrate' | 'annotation:preview' | 'annotation:screenshot:prepare' | 'annotation:screenshot:read' | 'annotation:submit' | 'annotation:resolve' | 'annotation:mark-read'
  | 'workspace:list' | 'workspace:get' | 'workspace:activate' | 'workspace:reorder' | 'workspace:restore-closed' | 'workspace:import-legacy'
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

export const listBrowserReferenceCandidates = (threadId: string) =>
  sidecarCall<BrowserReferenceCandidate[]>('browser:reference-candidates', { threadId })

export const createBrowserReferenceGrant = (input: BrowserReferenceGrantInput) =>
  sidecarCall<BrowserReferenceGrantResult>('browser:create-reference-grant', input)

export const revokeBrowserReferenceGrant = (input: { backend: 'iab' | 'extension'; threadId: string; referenceGrantId: string }) =>
  sidecarCall<{ ok: true; revoked?: boolean }>('browser:revoke-reference-grant', input)

export async function onBrowserEvent(listener: (event: { method: string; params: Record<string, unknown> }) => void) {
  return listen<{ method: string; params: Record<string, unknown> }>('browser:event', ({ payload }) => listener(payload))
}

export type { BrowserReferenceCandidate, BrowserReferenceGrantInput, BrowserReferenceGrantResult, BrowserSettings, BrowserTabDescriptor }
