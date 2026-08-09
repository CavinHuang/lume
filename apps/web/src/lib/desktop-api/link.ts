import type { LinkActionDetail, LinkActionSummary, LinkConnectionSummary, LinkOAuthConfigSummary, LinkOAuthSession, LinkProviderDetail, LinkProviderSummary, LinkRunDetail, LinkRunPage, LinkRuntimeDiagnostic, LinkRuntimeState } from '@lume/shared'
import { invoke } from '@/lib/desktop-runtime/core'
import { listen } from '@/lib/desktop-runtime/event'

const call = <T>(method: string, params: Record<string, unknown> = {}) => invoke<T>('sidecar_call', { method, params })

export const getLinkRuntimeState = () => invoke<LinkRuntimeState>('link_runtime_state')
export const enableLinkRuntime = () => invoke<LinkRuntimeState>('link_runtime_enable')
export const disableLinkRuntime = () => invoke<LinkRuntimeState>('link_runtime_disable')
export const restartLinkRuntime = () => invoke<LinkRuntimeState>('link_runtime_restart')
export const diagnoseLinkRuntime = () => invoke<LinkRuntimeDiagnostic>('link_runtime_diagnose')
export const changeLinkRuntimePort = (port: number) => invoke<LinkRuntimeState>('link_runtime_change_port', { port })
export const onLinkRuntimeState = (callback: (state: LinkRuntimeState) => void) => listen<LinkRuntimeState>('link:runtime', (event) => callback(event.payload))
export const onLinkDataChanged = (callback: () => void) => listen<{ method: string; params: unknown }>('sidecar:event', (event) => {
  if (event.payload.method === 'link:connections-changed' || event.payload.method === 'link:authorization-changed') callback()
})

export const listLinkProviders = (params: { query?: string; category?: string } = {}) => call<LinkProviderSummary[]>('link:providers-list', params)
export const searchLinkProviders = (query: string) => call<LinkProviderSummary[]>('link:providers-search', { query })
export const getLinkProvider = (service: string) => call<LinkProviderDetail>('link:provider-detail', { service })
export const listLinkConnections = () => call<LinkConnectionSummary[]>('link:connections-list')
export const upsertLinkConnection = (params: { service: string; connectionName: string; authType: string; credentials: Record<string, unknown> }) => call<LinkConnectionSummary>('link:connection-upsert', params)
export const deleteLinkConnection = (service: string, connectionName: string) => call('link:connection-delete', { service, connectionName })
export const listLinkOAuthConfigs = () => call<LinkOAuthConfigSummary[]>('link:oauth-configs')
export const listLinkOAuthSessions = () => call<LinkOAuthSession[]>('link:oauth-sessions')
export const saveLinkOAuthConfig = (service: string, clientId: string, clientSecret: string, extra: Record<string, string> = {}, secretExtra: Record<string, string> = {}) => call('link:oauth-config-save', { service, clientId, clientSecret, extra, secretExtra })
export const startLinkOAuth = (service: string, connectionName: string) => call<LinkOAuthSession>('link:oauth-start', { service, connectionName })
export const getLinkOAuthStatus = (state: string) => call<LinkOAuthSession>('link:oauth-status', { state })
export const cancelLinkOAuth = (state: string) => call<LinkOAuthSession>('link:oauth-cancel', { state })
export const listLinkActions = (params: { service?: string; query?: string } = {}) => call<LinkActionSummary[]>('link:actions-list', params)
export const getLinkAction = (action: string) => call<LinkActionDetail>('link:action-detail', { action })
export const listLinkRuns = (params: { limit?: number; cursor?: string; service?: string; actionId?: string; caller?: 'http' | 'mcp' | 'web'; ok?: boolean } = {}) => call<LinkRunPage>('link:runs-list', params)
export const getLinkRun = (runId: string) => call<LinkRunDetail>('link:run-detail', { runId })
