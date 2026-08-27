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
