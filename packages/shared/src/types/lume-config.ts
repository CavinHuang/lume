import type { AgentFollowUpMode } from "./agent"

export type LumeConfigPermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk"

export type LumeConfigThinkingLevel = "off" | "low" | "medium" | "high" | "max"

export interface LumeConfigAgentSection {
  permissionMode?: LumeConfigPermissionMode
  /**
   * 思考档位。作用域：仅主编码链路（经 engine 的会话请求）。未配置时按 "medium"
   * 执行（UI 与实际行为一致，不设「未配置」假档）。后台辅助消费方（advisor、
   * memory-v2 各服务、suggest/analyst、划词编辑、技能进化、vision router 等）
   * 不经 engine 直连 provider，恒按 medium 出网，不受此档位控制——豁免清单见
   * sidecar pi-ai-provider.ts resolveStreamThinkingOptions 注释。
   */
  thinkingLevel?: LumeConfigThinkingLevel
  followUpQueueMode?: AgentFollowUpMode
  /** 项目指令文件（CLAUDE.md/AGENTS.md）自动注入开关；缺省视为 true。 */
  projectInstructionsEnabled?: boolean
}

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

export interface LumeConfigAdvisorStrategy {
  /** Set false to keep the optional second-model review disabled. */
  enabled?: boolean
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
  followUpQueueMode?: AgentFollowUpMode
  /** #566:turn_limited 自动续跑轮数上限（默认 3；0 = 关闭自动续跑） */
  maxAutoTurnContinuations?: number
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
  mirrorUrl?: string
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
  advisor?: LumeConfigAdvisorStrategy
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
  /**
   * 配置 schema 代际。v2 起 classifier.enabled 出厂默认翻转（#571），迁移按代际
   * 一次性执行；磁盘上读取到的历史文件可能携带更旧值，故运行时以 number 承接，
   * 写入侧恒为当前 CONFIG_VERSION。
   */
  version: number
  workspaces?: Record<string, LumeConfigSectionSet>
}

export interface LumeEffectiveConfig extends LumeConfigSectionSet {
  version: number
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
