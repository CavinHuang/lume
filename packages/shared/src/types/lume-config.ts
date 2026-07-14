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

export interface LumeConfigRoutineModelStrategy {
  defaultModelRef?: string
}

export interface LumeConfigSimpleModelStrategy {
  defaultModelRef?: string
}

export interface LumeConfigImageGenerationStrategy {
  priorityModelRefs?: string[]
}

export type ComputerUseAgentSurface = "auto" | "sky" | "mcp"

export interface LumeConfigComputerUseStrategy {
  agentSurface?: ComputerUseAgentSurface
  skyModelRefs?: string[]
  visionModelRefs?: string[]
}

export interface LumeConfigAgentSection {
  permissionMode?: LumeConfigPermissionMode
  thinkingLevel?: LumeConfigThinkingLevel
}

export interface LumeConfigSkillsSection {
  enabled?: string[]
  disabled?: string[]
}

export interface LumeConfigPluginEnablement {
  enabled?: string[]
  disabled?: string[]
}

export interface LumeConfigPluginMarketSourceRef {
  id: string
  name: string
  kind: "local-index" | "remote-index"
  enabled: boolean
  url?: string
  path?: string
}

export interface LumeConfigPluginsSection {
  /** @deprecated normalized into global.enabled */
  enabled?: string[]
  /** @deprecated normalized into global.disabled */
  disabled?: string[]
  global?: LumeConfigPluginEnablement
  workspaces?: Record<string, LumeConfigPluginEnablement>
  directories?: string[]
  marketSources?: LumeConfigPluginMarketSourceRef[]
}

export interface LumeConfigModelsSection {
  chat?: {
    defaultModelRef?: string
  }
  agent?: LumeConfigAgentDefaultStrategy
  subagent?: LumeConfigSubagentModelStrategy
  routine?: LumeConfigRoutineModelStrategy
  automation?: LumeConfigSimpleModelStrategy
  background?: LumeConfigSimpleModelStrategy
  contextCompression?: LumeConfigSimpleModelStrategy
  title?: LumeConfigSimpleModelStrategy
  welcomeSuggestions?: LumeConfigSimpleModelStrategy
  permissionClassifier?: LumeConfigSimpleModelStrategy
  memoryJudgement?: LumeConfigSimpleModelStrategy
  imageGeneration?: LumeConfigImageGenerationStrategy
  computerUse?: LumeConfigComputerUseStrategy
  contextWindows?: Record<string, number>
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
  approvals?: LumeConfigPermissionApprovalRoutes
}

export type LumeConfigSubagentApprovalMode = "inherit" | "ask-parent" | "deny-high-risk"

export type LumeConfigApprovalAllowAlwaysPolicy = "disabled" | "desktop-only" | "dm-only" | "parent-only"

export type LumeConfigImGroupApprovalPolicy = "disabled" | "desktop-only"

export interface LumeConfigSubagentApprovalPolicy {
  mode?: LumeConfigSubagentApprovalMode
  allowAlways?: Exclude<LumeConfigApprovalAllowAlwaysPolicy, "dm-only">
}

export interface LumeConfigImAccountApprovalPolicy {
  enabled?: boolean
  allowTextApprove?: boolean
  allowAlways?: Exclude<LumeConfigApprovalAllowAlwaysPolicy, "parent-only">
  groupApproval?: LumeConfigImGroupApprovalPolicy
  approverPeerIds?: string[]
}

export interface LumeConfigImApprovalPolicy {
  enabled?: boolean
  allowTextApprove?: boolean
  allowAlways?: Exclude<LumeConfigApprovalAllowAlwaysPolicy, "parent-only">
  groupApproval?: LumeConfigImGroupApprovalPolicy
  accounts?: Record<string, LumeConfigImAccountApprovalPolicy>
}

export interface LumeConfigPermissionApprovalRoutes {
  desktop?: {
    enabled?: boolean
  }
  subagent?: LumeConfigSubagentApprovalPolicy
  im?: LumeConfigImApprovalPolicy
}

export const DEFAULT_LUME_PERMISSION_APPROVALS: LumeConfigPermissionApprovalRoutes = {
  desktop: {
    enabled: true
  },
  subagent: {
    mode: "ask-parent",
    allowAlways: "desktop-only"
  },
  im: {
    enabled: true,
    allowTextApprove: true,
    allowAlways: "desktop-only",
    groupApproval: "desktop-only",
    accounts: {}
  }
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

import type { WebSearchProvider } from "./general-settings"

export type WebSearchStrategy = "priority" | "joint"

export interface LumeConfigWebSearchSection {
  strategy?: WebSearchStrategy
  providers?: Partial<Record<WebSearchProvider, {
    enabled?: boolean
    apiKey?: string
  }>>
}

export const DEFAULT_LUME_WEB_SEARCH: LumeConfigWebSearchSection = {
  strategy: "priority",
  providers: {
    guanlan: { enabled: false },
    duckduckgo: { enabled: false },
    bing: { enabled: true }
  }
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
  webSearch?: LumeConfigWebSearchSection
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
