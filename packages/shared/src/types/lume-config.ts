export type LumeConfigPermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk"

export type LumeConfigThinkingLevel = "off" | "low" | "medium" | "high" | "max"

export interface LumeConfigAgentDefaultStrategy {
  defaultChannelId?: string
  defaultModelRef?: string
  fallbackModelRefs?: string[]
}

export interface LumeConfigSubagentModelStrategy {
  defaultModelRef?: string
}

export interface LumeConfigAgentSection {
  permissionMode?: LumeConfigPermissionMode
  thinkingLevel?: LumeConfigThinkingLevel
}

export interface LumeConfigSkillsSection {
  enabled?: string[]
  disabled?: string[]
}

export interface LumeConfigPluginsSection {
  enabled?: string[]
  directories?: string[]
}

export interface LumeConfigModelsSection {
  chat?: {
    defaultModelRef?: string
  }
  agent?: LumeConfigAgentDefaultStrategy
  subagent?: LumeConfigSubagentModelStrategy
  embedding?: {
    defaultModelRef?: string
  }
}

export interface LumeConfigPermissionsSection {
  toolPolicy?: {
    allow?: string[]
    deny?: string[]
  }
  rules?: LumeConfigPermissionRule[]
  classifier?: {
    enabled?: boolean
  }
  privateWriteRoots?: string[]
}

export interface LumeConfigHooksInternalSection {
  enabled?: boolean
  memory?: boolean
  security?: boolean
  observability?: boolean
}

export interface LumeConfigHooksSection {
  internal?: LumeConfigHooksInternalSection
}

export type LumeConfigPermissionRuleAction = "allow" | "ask" | "deny"

export type LumeConfigPermissionRuleScope = "session" | "workspace" | "global"

export interface LumeConfigPermissionRule {
  id?: string
  tool: string
  commandPattern?: string
  pathPattern?: string
  action: LumeConfigPermissionRuleAction
  scope?: LumeConfigPermissionRuleScope
}

export interface LumeConfigSectionSet {
  models?: LumeConfigModelsSection
  agent?: LumeConfigAgentSection
  providers?: Record<string, unknown>
  mcp?: Record<string, unknown>
  memory?: Record<string, unknown>
  skills?: LumeConfigSkillsSection
  plugins?: LumeConfigPluginsSection
  permissions?: LumeConfigPermissionsSection
  hooks?: LumeConfigHooksSection
}

export interface LumeConfigFile extends LumeConfigSectionSet {
  version: 1
  workspaces?: Record<string, LumeConfigSectionSet>
}

export interface LumeEffectiveConfig extends LumeConfigSectionSet {
  version: 1
  workspaceSlug?: string
  sourcePath: string
}

export type LumeConfigAuditSource = "user" | "agent" | "system"

export interface LumeConfigAuditEntry {
  at: string
  source: LumeConfigAuditSource
  workspaceSlug?: string
  path: string
  summary: string
}

export const LUME_CONFIG_IPC_CHANNELS = {
  GET_EFFECTIVE: "lume-config:get-effective",
  UPDATE_SECTION: "lume-config:update-section",
  GET_SOURCE_PATH: "lume-config:get-source-path",
  OPEN_SOURCE_FILE: "lume-config:open-source-file",
  CHANGED: "lume-config:changed"
} as const
