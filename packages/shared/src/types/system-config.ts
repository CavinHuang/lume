export interface LumeSystemModelSelectionConfig {
  defaultModelRef?: string
}

export interface LumeSystemEmbeddingConfig {
  defaultModelRef?: string
}

export interface LumeSystemModelsConfig {
  chat?: LumeSystemModelSelectionConfig
  agent?: LumeSystemModelSelectionConfig
  embedding?: LumeSystemEmbeddingConfig
  computerUse?: {
    agentSurface?: "auto" | "sky" | "mcp"
    skyModelRefs?: string[]
    visionModelRefs?: string[]
  }
}

export interface LumeSystemConfig {
  version: 1
  models?: LumeSystemModelsConfig
  memory?: Record<string, unknown>
  agent?: Record<string, unknown>
  automation?: Record<string, unknown>
  prompts?: Record<string, unknown>
  tools?: Record<string, unknown>
}

export interface EffectiveSystemConfig extends LumeSystemConfig {}

export interface NetworkDiagnosticEntry {
  name: string
  url: string
  ok: boolean
  statusCode?: number
  error?: string
}

export interface NetworkDiagnosticResult {
  proxy: {
    httpProxy?: string
    httpsProxy?: string
    noProxy?: string
  }
  checks: NetworkDiagnosticEntry[]
}

export const SYSTEM_CONFIG_IPC_CHANNELS = {
  GET_EFFECTIVE: "system-config:get-effective",
  UPDATE_SECTION: "system-config:update-section",
  NETWORK_DIAGNOSTIC: "system-config:network-diagnostic"
} as const
