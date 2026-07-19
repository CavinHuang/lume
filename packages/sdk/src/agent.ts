/**
 * Agent - High-level API
 *
 * Provides createAgent() and query() interfaces compatible with
 * the Claude-style Agent SDK surface while keeping the full
 * agent loop in-process.
 */

import type {
  AgentOptions,
  ContextUsageResult,
  InitializationResult,
  MCPServerStatus,
  Message,
  PermissionMode,
  Query as QueryHandle,
  QueryResult,
  ReloadPluginsResult,
  RewindFilesResult,
  SDKMessage,
  SDKUserMessage,
  SessionMessage,
  SlashCommand,
  ToolDefinition,
  CanUseToolFn,
  McpServerConfig,
  ContentBlockParam,
} from './types.js'
import { QueryEngine } from './engine.js'
import {
  assembleToolPool,
  filterTools,
  getAllBaseTools,
} from './tools/index.js'
import {
  closeAllConnections,
  connectMCPServer,
  type MCPConnection,
} from './mcp/client.js'
import { isSdkServerConfig } from './sdk-mcp-server.js'
import { registerAgents } from './tools/agent-tool.js'
import {
  saveSession,
  loadSession,
  listSessions,
  forkSession as forkStoredSession,
} from './session.js'
import { createHookRegistry, type HookRegistry } from './hooks.js'
import {
  getAllSkills,
  initBundledSkills,
  SkillRegistry,
} from './skills/index.js'
import { createSkillTool } from './tools/skill-tool.js'
import { createProvider, type LLMProvider, type ApiType } from './providers/index.js'
import type { NormalizedMessageParam } from './providers/types.js'
import {
  loadSettingsFromSources,
  mergeAgentOptions,
  type LoadedSettingsSource,
} from './utils/settings.js'
import { QueryController } from './query-controller.js'
import { loadPlugins, type LoadedPlugin } from './plugins/loader.js'
import { loadFilesystemSkills } from './skills/fs-loader.js'
import { loadCommandDefinitions, commandDefinitionsToSlashCommands } from './commands/fs-loader.js'
import type { CommandDefinition } from './commands/types.js'
import type { FileCheckpointState } from './utils/file-checkpoints.js'
import { rewindCheckpoint } from './utils/file-checkpoints.js'
import { getDefaultModels } from './utils/models.js'
import { setMcpConnections } from './tools/mcp-resource-tools.js'
import { getContextWindowSize } from './utils/tokens.js'
import { matchesAnyToolPattern } from './utils/tool-approval.js'
import { isToolSearchEnabled, setDeferredTools } from './tools/tool-search.js'

type QueryInput = string | ContentBlockParam[] | SDKUserMessage

function toSessionMessage(
  role: SessionMessage['role'],
  content: unknown,
): SessionMessage {
  return {
    uuid: crypto.randomUUID(),
    role,
    timestamp: new Date().toISOString(),
    content,
  }
}

function normalizePromptInput(prompt: QueryInput): string | ContentBlockParam[] {
  if (
    prompt &&
    typeof prompt === 'object' &&
    'type' in prompt &&
    prompt.type === 'user'
  ) {
    return prompt.message.content as string | ContentBlockParam[]
  }
  return prompt as string | ContentBlockParam[]
}

function createDisconnectedMcpConnection(
  name: string,
  config: McpServerConfig | any,
  tools: ToolDefinition[] = [],
  enabled = false,
): MCPConnection {
  return {
    name,
    status: 'disconnected',
    enabled,
    config,
    tools,
    listResources: async () => [],
    readResource: async () => undefined,
    subscribeResource: async () => {},
    unsubscribeResource: async () => {},
    close: async () => {},
  }
}

function extractSummary(messages: Message[]): string | undefined {
  const lastAssistant = [...messages].reverse().find((message) => message.type === 'assistant')
  if (!lastAssistant) return undefined

  return lastAssistant.message.content
    .filter((block: any) => block.type === 'text')
    .map((block: any) => block.text)
    .join('\n')
    .slice(0, 500) || undefined
}

function sliceSessionMessages(
  messages: SessionMessage[],
  upToMessageId?: string,
): SessionMessage[] {
  if (!upToMessageId) return messages
  const index = messages.findIndex((message) => message.uuid === upToMessageId)
  if (index === -1) return messages
  return messages.slice(0, index + 1)
}

function normalizeHistoryFromSessionMessages(
  messages: SessionMessage[],
): NormalizedMessageParam[] {
  return messages
    .filter(
      (message): message is SessionMessage & { role: 'user' | 'assistant' | 'runtime' } =>
        message.role === 'user' || message.role === 'assistant' || message.role === 'runtime',
    )
    .map((message) => ({
      role: message.role,
      content: normalizeSessionMessageContent(message),
    }))
}

function restoreMissingToolResults(
  history: NormalizedMessageParam[],
  storedMessages: NormalizedMessageParam[],
  sessionMessages: SessionMessage[],
): NormalizedMessageParam[] {
  const existingResultIds = new Set<string>()
  const restorableResults = new Map<string, Record<string, unknown>>()

  const collectToolResults = (
    messages: NormalizedMessageParam[],
    onResult: (id: string, block: Record<string, unknown>) => void,
  ): void => {
    for (const message of messages) {
      if (message.role !== 'user' || !Array.isArray(message.content)) continue
      for (const block of message.content) {
        if (block.type !== 'tool_result') continue
        onResult(block.tool_use_id, block as unknown as Record<string, unknown>)
      }
    }
  }

  collectToolResults(history, (id) => existingResultIds.add(id))
  collectToolResults(storedMessages, (id, block) => restorableResults.set(id, block))

  for (const message of sessionMessages) {
    if (message.role !== 'system' || !message.content || typeof message.content !== 'object') continue
    const event = message.content as Record<string, unknown>
    if (
      event.type !== 'system'
      || event.subtype !== 'tool_completed'
      || typeof event.tool_use_id !== 'string'
      || typeof event.output_summary !== 'string'
      || restorableResults.has(event.tool_use_id)
    ) {
      continue
    }
    restorableResults.set(event.tool_use_id, {
      type: 'tool_result',
      tool_use_id: event.tool_use_id,
      content: event.output_summary,
      is_error: event.is_error === true,
    })
  }

  if (restorableResults.size === 0) return history

  const restored: NormalizedMessageParam[] = []
  for (const message of history) {
    restored.push(message)
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue
    const missingResults = message.content.flatMap((block) => {
      if (block.type !== 'tool_use' || existingResultIds.has(block.id)) return []
      const result = restorableResults.get(block.id)
      if (!result) return []
      existingResultIds.add(block.id)
      return [result]
    })
    if (missingResults.length > 0) {
      restored.push({
        role: 'user',
        content: missingResults as ContentBlockParam[],
      })
    }
  }
  return restored
}

function normalizeSessionMessageContent(
  message: SessionMessage & { role: 'user' | 'assistant' | 'runtime' },
): NormalizedMessageParam['content'] {
  if (
    message.role === 'assistant' &&
    message.content &&
    typeof message.content === 'object' &&
    !Array.isArray(message.content) &&
    'role' in message.content &&
    (message.content as { role?: unknown }).role === 'assistant' &&
    'content' in message.content
  ) {
    return (message.content as { content: NormalizedMessageParam['content'] }).content
  }
  return message.content as NormalizedMessageParam['content']
}

function sessionMessagesFromHistory(
  messages: NormalizedMessageParam[],
): SessionMessage[] {
  return messages.map((message) => toSessionMessage(message.role, message.content))
}

export class Agent {
  private baseOptions: AgentOptions
  private cfg: AgentOptions
  private toolPool: ToolDefinition[] = []
  private modelId = 'claude-sonnet-4-6'
  private apiType: ApiType = 'anthropic-messages'
  private apiCredentials: { key?: string; baseUrl?: string } = {}
  private provider: LLMProvider
  private mcpLinks: MCPConnection[] = []
  private history: NormalizedMessageParam[] = []
  private messageLog: Message[] = []
  private sessionMessages: SessionMessage[] = []
  private setupDone: Promise<void>
  private sid: string
  private abortCtrl: AbortController | null = null
  private currentEngine: QueryEngine | null = null
  private hookRegistry: HookRegistry
  private loadedSettings: LoadedSettingsSource[] = []
  private loadedPlugins: LoadedPlugin[] = []
  private pluginSkillNames = new Set<string>()
  private explicitSkillNames = new Set<string>()
  private fileSkillNames = new Set<string>()
  private loadedCommands: CommandDefinition[] = []
  private fileCheckpointState: FileCheckpointState = {}
  private lastContextUsage: ContextUsageResult | null = null
  private disabledMcpServers = new Set<string>()
  private queuedSdkEvents: SDKMessage[] = []
  private readonly skillRegistry: SkillRegistry

  constructor(options: AgentOptions = {}) {
    this.baseOptions = { ...options }
    this.cfg = { ...options }
    this.sid = this.cfg.sessionId ?? crypto.randomUUID()
    this.provider = createProvider('anthropic-messages', {})
    this.hookRegistry = createHookRegistry()
    initBundledSkills()
    this.skillRegistry = new SkillRegistry(getAllSkills())
    this.setupDone = this.setup()
  }

  private readEnv(key: string): string | undefined {
    return process.env[key] || undefined
  }

  private pickCredentials(): { key?: string; baseUrl?: string } {
    const envMap = this.cfg.env
    return {
      key:
        this.cfg.apiKey ??
        envMap?.CODEANY_API_KEY ??
        envMap?.CODEANY_AUTH_TOKEN ??
        this.readEnv('CODEANY_API_KEY') ??
        this.readEnv('CODEANY_AUTH_TOKEN'),
      baseUrl:
        this.cfg.baseURL ??
        envMap?.CODEANY_BASE_URL ??
        this.readEnv('CODEANY_BASE_URL'),
    }
  }

  private resolveApiType(): ApiType {
    if (this.cfg.apiType) return this.cfg.apiType

    const envType =
      this.cfg.env?.CODEANY_API_TYPE ??
      this.readEnv('CODEANY_API_TYPE')
    if (
      envType === 'openai-completions' ||
      envType === 'anthropic-messages' ||
      envType === 'deepseek-chat-completions' ||
      envType === 'openai-responses'
    ) {
      return envType
    }

    const baseUrl = (
      this.apiCredentials.baseUrl ??
      this.cfg.baseURL ??
      this.cfg.env?.CODEANY_BASE_URL ??
      this.readEnv('CODEANY_BASE_URL') ??
      ''
    ).toLowerCase()
    if (baseUrl) {
      if (baseUrl.includes('/anthropic') || /\/messages\/?$/.test(baseUrl)) {
        return 'anthropic-messages'
      }
      if (baseUrl.includes('api.deepseek.com')) {
        return 'deepseek-chat-completions'
      }
      if (baseUrl.includes('/chat/completions')) {
        return 'openai-completions'
      }
      if (baseUrl.includes('/responses')) {
        return 'openai-responses'
      }
    }

    const model = this.modelId.toLowerCase()
    if (
      model.includes('gpt-') ||
      model.includes('o1') ||
      model.includes('o3') ||
      model.includes('o4') ||
      model.includes('qwen') ||
      model.includes('yi-') ||
      model.includes('glm') ||
      model.includes('mistral') ||
      model.includes('gemma')
    ) {
      return 'openai-completions'
    }

    if (model.includes('deepseek')) {
      return 'deepseek-chat-completions'
    }

    return 'anthropic-messages'
  }

  private refreshResolvedConfig(): void {
    this.apiCredentials = this.pickCredentials()
    this.modelId = this.cfg.model ?? this.readEnv('CODEANY_MODEL') ?? 'claude-sonnet-4-6'
    this.apiType = this.resolveApiType()
    this.provider = createProvider(this.apiType, {
      apiKey: this.apiCredentials.key,
      baseURL: this.apiCredentials.baseUrl,
    })
    if (this.cfg.sessionId) {
      this.sid = this.cfg.sessionId
    }
  }

  private resetHookRegistry(): void {
    this.hookRegistry = createHookRegistry()

    if (this.cfg.hooks) {
      for (const [event, defs] of Object.entries(this.cfg.hooks)) {
        for (const def of defs) {
          for (const handler of def.hooks) {
            this.hookRegistry.register(event as any, {
              matcher: def.matcher,
              timeout: def.timeout,
              handler: async (input) => {
                const result = await handler(input, input.toolUseId || '', {
                  signal: this.abortCtrl?.signal || new AbortController().signal,
                })
                return result || undefined
              },
            })
          }
        }
      }
    }

    for (const plugin of this.loadedPlugins) {
      if (!plugin.hooks) continue
      const hookCount = Object.values(plugin.hooks).reduce((sum, defs) => sum + defs.length, 0)
      console.debug(`[plugin:agent] registering hooks for "${plugin.name}"`, {
        events: Object.keys(plugin.hooks),
        totalHooks: hookCount,
      });
      this.hookRegistry.registerFromConfig(plugin.hooks)
    }
  }

  private unregisterPluginSkills(): void {
    for (const name of this.pluginSkillNames) {
      this.skillRegistry.unregister(name)
    }
    this.pluginSkillNames.clear()
  }

  private registerPluginSkills(): void {
    this.unregisterPluginSkills()
    for (const plugin of this.loadedPlugins) {
      if (plugin.lume?.hooksOnly) continue
      const skills = plugin.skills || []
      console.debug(`[plugin:agent] registering skills for "${plugin.name}"`, {
        count: skills.length,
        names: skills.map((s) => s.name),
      });
      for (const skill of skills) {
        this.skillRegistry.register(skill)
        this.pluginSkillNames.add(skill.name)
      }
    }
  }

  private unregisterExplicitSkills(): void {
    for (const name of this.explicitSkillNames) {
      this.skillRegistry.unregister(name)
    }
    this.explicitSkillNames.clear()
  }

  private registerExplicitSkills(): void {
    this.unregisterExplicitSkills()
    for (const skill of this.cfg.skills || []) {
      this.skillRegistry.register(skill)
      this.explicitSkillNames.add(skill.name)
    }
  }

  private unregisterFileSkills(): void {
    for (const name of this.fileSkillNames) {
      this.skillRegistry.unregister(name)
    }
    this.fileSkillNames.clear()
  }

  private async registerFilesystemSkills(input: {
    cwd: string
    roots?: string[]
    shouldLoadSkill?: AgentOptions['shouldLoadFilesystemSkill']
  }): Promise<void> {
    this.unregisterFileSkills()
    const skills = await loadFilesystemSkills(input)
    for (const skill of skills) {
      this.skillRegistry.register(skill)
      this.fileSkillNames.add(skill.name)
    }
  }

  private getPluginAgents(): Record<string, NonNullable<AgentOptions['agents']>[string]> {
    const merged: Record<string, NonNullable<AgentOptions['agents']>[string]> = {}
    for (const plugin of this.loadedPlugins) {
      Object.assign(merged, plugin.agents || {})
    }
    return merged
  }

  private getPluginTools(): ToolDefinition[] {
    return this.loadedPlugins.flatMap((plugin) => {
      if (plugin.lume?.hooksOnly) return []
      return plugin.tools || []
    })
  }

  private getPluginCommands(): CommandDefinition[] {
    return this.loadedPlugins.flatMap((plugin) => {
      if (plugin.lume?.hooksOnly) return []
      return plugin.commands || []
    })
  }

  private getPluginMcpServers(): Record<string, McpServerConfig | any> {
    const merged: Record<string, McpServerConfig | any> = {}
    for (const plugin of this.loadedPlugins) {
      if (plugin.lume?.hooksOnly) continue
      Object.assign(merged, plugin.mcpServers || {})
    }
    return merged
  }

  private buildBaseToolPool(options: AgentOptions = this.cfg): ToolDefinition[] {
    const pluginTools = this.getPluginTools()
    const bindSkillRegistry = (tool: ToolDefinition) => tool.name === 'Skill'
      ? createSkillTool(this.skillRegistry)
      : tool
    const baseTools = getAllBaseTools().map(bindSkillRegistry)
    const raw = options.tools
    let pool: ToolDefinition[]

    if (!raw || (typeof raw === 'object' && !Array.isArray(raw) && 'type' in raw)) {
      pool = [...baseTools, ...pluginTools]
    } else if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === 'string') {
      pool = filterTools([...baseTools, ...pluginTools], raw as string[])
    } else {
      pool = [...(raw as ToolDefinition[]).map(bindSkillRegistry), ...pluginTools]
    }

    return filterTools(pool, undefined, options.disallowedTools)
  }

  private getConfiguredMcpServers(): Record<string, McpServerConfig | any> {
    return {
      ...(this.cfg.mcpServers || {}),
      ...this.getPluginMcpServers(),
    }
  }

  private async syncMcpConnections(): Promise<void> {
    await closeAllConnections(this.mcpLinks)
    this.mcpLinks = []

    const configs = this.getConfiguredMcpServers()
    for (const [name, config] of Object.entries(configs)) {
      const originalResourceUpdate = (config as any).onResourceUpdate
      const wrappedConfig = {
        ...config,
        onResourceUpdate: async (update: any) => {
          if (update.kind === 'elicitation_complete' && update.elicitationId) {
            this.queuedSdkEvents.push({
              type: 'system',
              subtype: 'elicitation_complete',
              mcp_server_name: name,
              elicitation_id: update.elicitationId,
              session_id: this.sid,
            })
          } else {
            this.queuedSdkEvents.push({
              type: 'system',
              subtype: 'status',
              message: `MCP ${name} ${update.kind} updated`,
              session_id: this.sid,
              permissionMode: this.cfg.permissionMode,
            })
          }
          await originalResourceUpdate?.(update)
        },
      }

      if (this.disabledMcpServers.has(name)) {
        const tools = isSdkServerConfig(wrappedConfig) ? wrappedConfig.tools : []
        this.mcpLinks.push(createDisconnectedMcpConnection(name, wrappedConfig, tools, false))
        continue
      }

      if (isSdkServerConfig(wrappedConfig)) {
        this.mcpLinks.push({
          name,
          status: 'connected',
          enabled: true,
          config: wrappedConfig,
          tools: wrappedConfig.tools,
          listResources: async () => [],
          readResource: async () => undefined,
          subscribeResource: async () => {},
          unsubscribeResource: async () => {},
          close: async () => {},
        })
        continue
      }

      const connection = await connectMCPServer(name, wrappedConfig)
      connection.enabled = true
      connection.config = wrappedConfig
      this.mcpLinks.push(connection)
    }

    setMcpConnections(this.mcpLinks.filter((conn) => conn.enabled))
  }

  private async rebuildToolPool(options: AgentOptions = this.cfg): Promise<void> {
    const baseTools = this.buildBaseToolPool(options)
    const mcpTools = this.mcpLinks
      .filter((conn) => conn.enabled && conn.status === 'connected')
      .flatMap((conn) => conn.tools)

    const assembledTools = assembleToolPool(
      baseTools,
      mcpTools,
      undefined,
      options.disallowedTools,
    )
    this.toolPool = options.resolveRuntimeTools
      ? await options.resolveRuntimeTools(assembledTools, {
        cwd: options.cwd || process.cwd(),
        sessionId: this.sid,
        permissionMode: options.permissionMode,
      })
      : assembledTools

    const allKnownTools = assembleToolPool(
      [...getAllBaseTools(), ...this.getPluginTools()],
      mcpTools,
      undefined,
      undefined,
    )
    const visibleNames = new Set(this.toolPool.map((tool) => tool.name))
    const deferredCandidates = allKnownTools.filter((tool) => !visibleNames.has(tool.name))
    const enableToolSearch = isToolSearchEnabled(
      deferredCandidates,
      options.model || this.modelId,
    )
    setDeferredTools(enableToolSearch ? deferredCandidates : [])
  }

  private drainQueuedSdkEvents(): SDKMessage[] {
    const events = [...this.queuedSdkEvents]
    this.queuedSdkEvents.length = 0
    return events
  }

  private async resumeSessionIfNeeded(): Promise<void> {
    let resumeId = this.cfg.resume

    if (!resumeId && this.cfg.continue) {
      const latest = await listSessions({
        dir: this.cfg.cwd || process.cwd(),
        limit: 1,
      })
      resumeId = latest[0]?.id
    }

    if (resumeId && this.cfg.forkSession) {
      const forked = await forkStoredSession(resumeId, {
        dir: this.cfg.cwd || process.cwd(),
        newSessionId: this.cfg.sessionId,
      })
      resumeId = typeof forked === 'string' ? forked : forked?.sessionId
    }

    if (!resumeId) return

    const sessionData = await loadSession(resumeId)
    if (!sessionData) return

    const resumedSessionMessages = sliceSessionMessages(
      sessionData.sessionMessages || [],
      this.cfg.resumeSessionAt,
    )

    const resumedHistory = resumedSessionMessages.length > 0
      ? normalizeHistoryFromSessionMessages(resumedSessionMessages)
      : sessionData.messages
    this.history = restoreMissingToolResults(
      resumedHistory,
      sessionData.messages,
      resumedSessionMessages,
    )
    this.sessionMessages = resumedSessionMessages.length > 0
      ? resumedSessionMessages
      : (sessionData.sessionMessages || [])
    this.fileCheckpointState = sessionData.checkpoints || {}
    this.sid = resumeId
  }

  private async setup(): Promise<void> {
    const cwd = this.cfg.cwd || process.cwd()
    if (this.cfg.settingSources?.length) {
      this.loadedSettings = await loadSettingsFromSources(cwd, this.cfg.settingSources)
      this.cfg = mergeAgentOptions(
        {} as AgentOptions,
        [
          ...this.loadedSettings.map((source) => source.settings as Partial<AgentOptions> & Record<string, unknown>),
          this.baseOptions as Partial<AgentOptions> & Record<string, unknown>,
        ],
      )
    }

    this.refreshResolvedConfig()
    this.loadedPlugins = await loadPlugins(this.cfg.cwd || process.cwd(), this.cfg.plugins)
    console.debug(`[plugin:agent] plugins loaded`, {
      count: this.loadedPlugins.length,
      names: this.loadedPlugins.map((p) => p.name),
      hooksOnly: this.loadedPlugins.filter((p) => p.lume?.hooksOnly).map((p) => p.name),
    });
    this.registerPluginSkills()
    await this.registerFilesystemSkills({
      cwd,
      roots: this.cfg.skillsDirectories,
      shouldLoadSkill: this.cfg.shouldLoadFilesystemSkill,
    })
    this.registerExplicitSkills()
    this.loadedCommands = [
      ...(await loadCommandDefinitions(cwd)),
      ...this.getPluginCommands(),
    ]
    this.resetHookRegistry()

    const mergedAgents = {
      ...this.getPluginAgents(),
      ...(this.cfg.agents || {}),
    }
    if (Object.keys(mergedAgents).length > 0) {
      registerAgents(mergedAgents)
    }

    await this.syncMcpConnections()
    await this.rebuildToolPool()
    await this.resumeSessionIfNeeded()
  }

  private getEffectiveOptions(overrides?: Partial<AgentOptions>): AgentOptions {
    const merged = { ...this.cfg, ...overrides }
    // thinkingConfig is an alias for thinking (thinking takes precedence)
    if (!merged.thinking && merged.thinkingConfig) {
      merged.thinking = merged.thinkingConfig
    }
    if (!merged.thinking && merged.maxThinkingTokens !== undefined) {
      merged.thinking = merged.maxThinkingTokens === null
        ? { type: 'disabled' }
        : { type: 'enabled', budgetTokens: merged.maxThinkingTokens }
    }
    // allowDangerouslySkipPermissions forces bypassPermissions mode
    if (merged.allowDangerouslySkipPermissions && !merged.permissionMode) {
      merged.permissionMode = 'bypassPermissions'
    }
    return merged
  }

  private getCanUseTool(opts: AgentOptions): CanUseToolFn {
    if (opts.canUseTool) return opts.canUseTool

    const permMode = opts.permissionMode ?? 'bypassPermissions'
    const allowedToolPatterns = opts.allowedTools || []
    const disallowedToolPatterns = opts.disallowedTools || []
    const readOnlyNames = new Set([
      'Read',
      'Glob',
      'Grep',
      'WebFetch',
      'WebSearch',
      'ListMcpResourcesTool',
      'ReadMcpResourceTool',
      'TaskOutput',
      'TaskGet',
      'TaskList',
      'ToolSearch',
      'AskUserQuestion',
    ])
    const editNames = new Set([
      'Write',
      'Edit',
      'NotebookEdit',
      'TodoWrite',
      'Config',
    ])
    const privilegedNames = new Set([
      'Bash',
      'Agent',
      'SendMessage',
      'TeamCreate',
      'TeamDelete',
      'CronCreate',
      'CronDelete',
      'RemoteTrigger',
    ])

    return async (tool, _input, metadata) => {
      const base = {
        title: metadata?.title,
        displayName: metadata?.displayName,
        description: metadata?.description,
        blockedPath: metadata?.blockedPath,
        permissionSuggestions: metadata?.permissionSuggestions,
        decisionReason: metadata?.decisionReason,
      }

      if (matchesAnyToolPattern(tool.name, disallowedToolPatterns)) {
        return {
          behavior: 'deny',
          message: `Tool "${tool.name}" is disallowed by configuration.`,
          ...base,
        }
      }

      if (matchesAnyToolPattern(tool.name, allowedToolPatterns)) {
        return { behavior: 'allow', ...base }
      }

      if (permMode === 'bypassPermissions' || permMode === 'dontAsk' || permMode === 'auto') {
        return { behavior: 'allow', ...base }
      }

      if (permMode === 'plan') {
        if (tool.isReadOnly?.() || readOnlyNames.has(tool.name)) {
          return { behavior: 'allow', ...base }
        }
        return {
          behavior: 'deny',
          message: `Plan mode blocks mutating tool "${tool.name}" until planning is complete.`,
          ...base,
        }
      }

      if (permMode === 'acceptEdits') {
        if (privilegedNames.has(tool.name)) {
          return {
            behavior: 'deny',
            message: `acceptEdits mode does not auto-allow privileged tool "${tool.name}".`,
            ...base,
          }
        }
        if (tool.isReadOnly?.() || readOnlyNames.has(tool.name) || editNames.has(tool.name) || tool.name === 'TaskStop') {
          return { behavior: 'allow', ...base }
        }
        return { behavior: 'deny', message: `Tool "${tool.name}" is not allowed in acceptEdits mode.`, ...base }
      }

      if (permMode === 'default') {
        if (tool.isReadOnly?.() || readOnlyNames.has(tool.name)) {
          return { behavior: 'allow', ...base }
        }
        return {
          behavior: 'deny',
          message: `Default mode requires explicit approval for "${tool.name}". Provide a custom canUseTool callback to allow it.`,
          ...base,
        }
      }

      return { behavior: 'allow', ...base }
    }
  }

  private async persistCurrentSession(
    cwd: string,
    opts: AgentOptions,
  ): Promise<SDKMessage | null> {
    if (opts.persistSession === false || (this.history.length === 0 && this.sessionMessages.length === 0)) {
      return null
    }

    try {
      await saveSession(this.sid, this.history, {
        cwd,
        model: opts.model || this.modelId,
        summary: extractSummary(this.messageLog),
        sessionMessages: this.sessionMessages,
        checkpoints: this.fileCheckpointState,
      })
      return {
        type: 'system',
        subtype: 'files_persisted',
        files: [
          {
            filename: 'transcript.json',
            file_id: this.sid,
          },
        ],
        failed: [],
        processed_at: new Date().toISOString(),
        session_id: this.sid,
      }
    } catch {
      // Session persistence is best-effort.
      return null
    }
  }

  private async *runSinglePrompt(
    prompt: QueryInput,
    overrides?: Partial<AgentOptions>,
  ): AsyncGenerator<SDKMessage, void> {
    await this.setupDone

    const opts = this.getEffectiveOptions(overrides)
    const cwd = opts.cwd || process.cwd()

    // Skills are editable while an Agent instance is alive. Refresh them at the
    // turn boundary so additions, updates, and deletions take effect without a
    // sidecar restart. Re-register explicit skills last to preserve precedence.
    await this.registerFilesystemSkills({
      cwd,
      roots: opts.skillsDirectories,
      shouldLoadSkill: opts.shouldLoadFilesystemSkill,
    })
    this.registerExplicitSkills()

    this.abortCtrl = opts.abortController || new AbortController()
    if (opts.abortSignal) {
      opts.abortSignal.addEventListener('abort', () => this.abortCtrl?.abort(), { once: true })
    }

    let systemPrompt: string | undefined
    let appendSystemPrompt = opts.appendSystemPrompt
    if (typeof opts.systemPrompt === 'object' && opts.systemPrompt?.type === 'preset') {
      systemPrompt = undefined
      if (opts.systemPrompt.append) {
        appendSystemPrompt = [appendSystemPrompt, opts.systemPrompt.append].filter(Boolean).join('\n')
      }
    } else {
      systemPrompt = opts.systemPrompt as string | undefined
    }


    let tools = this.toolPool
    if (overrides?.disallowedTools) {
      tools = filterTools(tools, undefined, overrides.disallowedTools)
    }
    if (overrides?.tools) {
      const raw = overrides.tools
      if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === 'string') {
        tools = filterTools(this.buildBaseToolPool(opts), raw as string[])
      } else if (Array.isArray(raw)) {
        tools = raw as ToolDefinition[]
      }
    }

    let provider = this.provider
    if (overrides?.apiType || overrides?.apiKey || overrides?.baseURL) {
      const resolvedApiType = overrides.apiType ?? this.apiType
      provider = createProvider(resolvedApiType, {
        apiKey: overrides.apiKey ?? this.apiCredentials.key,
        baseURL: overrides.baseURL ?? this.apiCredentials.baseUrl,
      })
    }

    const normalizedPrompt = normalizePromptInput(prompt)
    const modelFacingPrompt = normalizedPrompt
    const isManualCompactCommand = typeof normalizedPrompt === 'string' && normalizedPrompt.trim() === '/compact'
    const runtimeMessage = !isManualCompactCommand && opts.runtimeContext?.trim()
      ? toSessionMessage('runtime', opts.runtimeContext.trim())
      : null
    const userMessage = isManualCompactCommand ? null : toSessionMessage('user', normalizedPrompt)
    if (runtimeMessage) {
      this.sessionMessages.push(runtimeMessage)
    }
    if (userMessage) {
      this.sessionMessages.push(userMessage)
      this.messageLog.push({
        type: 'user',
        message: { role: 'user', content: normalizedPrompt },
        uuid: userMessage.uuid,
        timestamp: userMessage.timestamp,
      })
      await this.persistCurrentSession(cwd, opts)
    }

    const engine = new QueryEngine({
      cwd,
      model: opts.model || this.modelId,
      provider,
      tools,
      systemPrompt,
      runtimeContext: runtimeMessage ? opts.runtimeContext?.trim() : undefined,
      promptCache: opts.promptCache,
      appendSystemPrompt,
      maxTurns: opts.maxTurns ?? 10,
      maxBudgetUsd: opts.maxBudgetUsd,
      maxTokens: opts.maxTokens ?? 16384,
      thinking: opts.thinking,
      jsonSchema: opts.jsonSchema,
      outputFormat: opts.outputFormat,
      effort: opts.effort,
      canUseTool: this.getCanUseTool(opts),
      includePartialMessages: opts.includePartialMessages ?? false,
      abortSignal: this.abortCtrl.signal,
      agents: {
        ...this.getPluginAgents(),
        ...(opts.agents || {}),
      },
      hookRegistry: this.hookRegistry,
      sessionId: this.sid,
      permissionMode: opts.permissionMode,
      promptSuggestions: opts.promptSuggestions,
      additionalDirectories: opts.additionalDirectories,
      skillRegistry: this.skillRegistry,
      initialization: {
        slashCommands: this.getInitializationCommands().map((command) => command.name),
        skills: this.skillRegistry.getUserInvocable().map((skill) => skill.name),
        plugins: this.loadedPlugins.map((plugin) => ({
          name: plugin.name,
          path: plugin.path,
          source: plugin.source,
        })),
        outputStyle: opts.outputStyle || 'text',
        claudeCodeVersion: 'open-agent-sdk/0.2.0',
        apiKeySource: this.apiCredentials.key ? 'configured' : 'missing',
      },
      sandbox: opts.sandbox,
      toolConfig: opts.toolConfig,
      currentUserMessageId: userMessage?.uuid ?? `command:${this.sid}:compact`,
      fileCheckpointState: this.fileCheckpointState,
      mcpServerStatuses: this.collectMcpServerStatuses().map((status) => ({
        name: status.name,
        status: status.status,
      })),
      contextController: opts.contextController,
      completionGuard: opts.completionGuard,
    })
    this.currentEngine = engine

    for (const msg of this.history) {
      engine.messages.push(msg)
    }

    for (const queued of this.drainQueuedSdkEvents()) {
      yield queued
    }

    yield {
      type: 'auth_status',
      isAuthenticating: false,
      output: this.apiCredentials.key
        ? [`Using ${this.apiType} credentials`]
        : ['No API key configured'],
      error: this.apiCredentials.key ? undefined : 'Missing API key',
      session_id: this.sid,
    }

    let persistedSessionEvent: SDKMessage | null = null
    let compactionBoundarySeen = false
    try {
      for await (const event of engine.submitMessage(modelFacingPrompt)) {
        if (event.type === 'assistant') {
          const assistantMessage = toSessionMessage('assistant', event.message)
          this.sessionMessages.push(assistantMessage)
          this.messageLog.push({
            type: 'assistant',
            message: event.message,
            uuid: assistantMessage.uuid,
            timestamp: assistantMessage.timestamp,
          })
        } else if (event.type === 'tool_result') {
          this.sessionMessages.push(toSessionMessage('user', [{
            type: 'tool_result',
            tool_use_id: event.result.tool_use_id,
            tool_name: event.result.tool_name,
            content: event.result.content ?? event.result.output,
            is_error: event.result.is_error === true,
          }]))
        } else if (event.type === 'system') {
          this.sessionMessages.push(toSessionMessage('system', event))
          if (event.subtype === 'compact_boundary') {
            compactionBoundarySeen = true
          }
        }

        yield event
        for (const queued of this.drainQueuedSdkEvents()) {
          yield queued
        }
      }
    } finally {
      this.history = engine.getMessages()
      this.lastContextUsage = engine.getContextUsage()
      this.currentEngine = null
      if (compactionBoundarySeen) {
        this.sessionMessages = sessionMessagesFromHistory(this.history)
      }
      persistedSessionEvent = await this.persistCurrentSession(cwd, opts)
    }

    if (persistedSessionEvent) {
      yield persistedSessionEvent
    }

    for (const queued of this.drainQueuedSdkEvents()) {
      yield queued
    }
  }

  private async *runPromptQueue(
    inputs: AsyncIterable<QueryInput>,
    overrides?: Partial<AgentOptions>,
  ): AsyncGenerator<SDKMessage, void> {
    for await (const prompt of inputs) {
      yield* this.runSinglePrompt(prompt, overrides)
    }
  }

  private buildQueryHandle(
    initialInput: QueryInput | AsyncIterable<QueryInput>,
    overrides?: Partial<AgentOptions>,
    onFinished?: () => Promise<void>,
  ): QueryHandle {
    const runner = async function* (
      this: Agent,
      inputs: AsyncIterable<QueryInput>,
    ): AsyncGenerator<SDKMessage> {
      try {
        yield* this.runPromptQueue(inputs, overrides)
      } finally {
        if (onFinished) {
          await onFinished()
        }
      }
    }.bind(this)

    return new QueryController(
      {
        interrupt: () => this.interrupt(),
        setPermissionMode: (mode) => this.setPermissionMode(mode),
        setModel: (model) => this.setModel(model),
        setMaxThinkingTokens: (tokens) => this.setMaxThinkingTokens(tokens),
        setCwd: (cwd) => this.setCwd(cwd),
        getInitializationResult: () => this.getInitializationResult(),
        getContextUsage: () => this.getContextUsage(),
        mcpServerStatus: () => this.mcpServerStatus(),
        setMcpServers: (servers) => this.setMcpServers(servers),
        reconnectMcpServer: (serverName) => this.reconnectMcpServer(serverName),
        toggleMcpServer: (serverName, enabled) => this.toggleMcpServer(serverName, enabled),
        reloadPlugins: () => this.reloadPlugins(),
        rewindFiles: (userMessageId, dryRun) => this.rewindFiles(userMessageId, dryRun),
        stopTask: (taskId) => this.stopTask(taskId),
      },
      runner,
      initialInput,
    )
  }

  query(
    prompt: QueryInput | AsyncIterable<QueryInput>,
    overrides?: Partial<AgentOptions>,
  ): QueryHandle {
    return this.buildQueryHandle(prompt, overrides)
  }

  async prompt(
    text: string,
    overrides?: Partial<AgentOptions>,
  ): Promise<QueryResult> {
    const t0 = performance.now()
    const collected = { text: '', turns: 0, tokens: { in: 0, out: 0 } }

    for await (const ev of this.query(text, overrides)) {
      switch (ev.type) {
        case 'assistant': {
          const fragments = (ev.message.content as any[])
            .filter((c: any) => c.type === 'text')
            .map((c: any) => c.text)
          if (fragments.length) collected.text = fragments.join('')
          break
        }
        case 'result':
          collected.turns = ev.num_turns ?? 0
          collected.tokens.in = ev.usage?.input_tokens ?? 0
          collected.tokens.out = ev.usage?.output_tokens ?? 0
          break
      }
    }

    return {
      text: collected.text,
      usage: { input_tokens: collected.tokens.in, output_tokens: collected.tokens.out },
      num_turns: collected.turns,
      duration_ms: Math.round(performance.now() - t0),
      messages: [...this.messageLog],
    }
  }

  getMessages(): Message[] {
    return [...this.messageLog]
  }

  clear(): void {
    this.history = []
    this.messageLog = []
    this.sessionMessages = []
    this.fileCheckpointState = {}
  }

  async interrupt(): Promise<void> {
    this.abortCtrl?.abort('interrupt')
  }

  async setModel(model?: string): Promise<void> {
    if (model) {
      this.cfg.model = model
      this.modelId = model
      this.refreshResolvedConfig()
    }
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.cfg.permissionMode = mode
  }

  async setMaxThinkingTokens(maxThinkingTokens: number | null): Promise<void> {
    if (maxThinkingTokens === null) {
      this.cfg.thinking = { type: 'disabled' }
    } else {
      this.cfg.thinking = { type: 'enabled', budgetTokens: maxThinkingTokens }
    }
  }

  async setCwd(cwd: string): Promise<void> {
    this.cfg.cwd = cwd
    this.baseOptions.cwd = cwd
    this.setupDone = this.setup()
    await this.setupDone
  }

  getSessionId(): string {
    return this.sid
  }

  getApiType(): ApiType {
    return this.apiType
  }

  async stopTask(taskId: string): Promise<void> {
    const { getTask } = await import('./tools/task-tools.js')
    const task = getTask(taskId)
    if (task) {
      task.status = 'cancelled'
    }
  }

  private getInitializationCommands(): SlashCommand[] {
    const builtins: SlashCommand[] = [
      { name: '/clear', description: 'Clear the current conversation context' },
      { name: '/compact', description: 'Compact the current conversation history' },
      { name: '/resume', description: 'Resume a prior session' },
      { name: '/mcp', description: 'Inspect MCP server status' },
      { name: '/reload-plugins', description: 'Reload plugins from disk' },
    ]
    const fileAndPluginCommands = commandDefinitionsToSlashCommands(this.loadedCommands)
    const byName = new Map<string, SlashCommand>()
    for (const command of [...builtins, ...fileAndPluginCommands]) {
      byName.set(command.name, {
        name: command.name,
        description: command.description,
        ...(command.argumentHint ? { argumentHint: command.argumentHint } : {}),
      })
    }
    return Array.from(byName.values())
  }

  async getInitializationResult(): Promise<InitializationResult> {
    await this.setupDone

    const commands = this.getInitializationCommands()

    return {
      commands,
      agents: Object.entries({
        ...this.getPluginAgents(),
        ...(this.cfg.agents || {}),
      }).map(([name, agent]) => ({
        name,
        description: agent.description,
      })),
      output_style: 'text',
      available_output_styles: ['text', 'json', 'streamlined'],
      models: getDefaultModels(),
      account: {
        tokenSource: this.apiCredentials.key ? 'configured' : 'missing',
        apiKeySource: this.apiCredentials.key ? 'configured' : 'missing',
      },
      slash_commands: commands.map((command) => command.name),
      skills: this.skillRegistry.getUserInvocable().map((skill) => skill.name),
      plugins: this.loadedPlugins.map((plugin) => ({
        name: plugin.name,
        path: plugin.path,
        source: plugin.source,
      })),
    }
  }

  async getContextUsage(): Promise<ContextUsageResult> {
    await this.setupDone
    if (this.currentEngine) {
      return this.currentEngine.getContextUsage()
    }
    if (this.lastContextUsage) {
      return this.lastContextUsage
    }
    const init = await this.getInitializationResult()
    return {
      categories: [
        { name: 'messages', tokens: 0, color: 'blue' },
        { name: 'system', tokens: 0, color: 'green' },
        { name: 'tools', tokens: 0, color: 'orange' },
      ],
      totalTokens: 0,
      maxTokens: getContextWindowSize(this.modelId),
      rawMaxTokens: getContextWindowSize(this.modelId),
      percentage: 0,
      gridRows: [],
      model: this.modelId,
      memoryFiles: [],
      mcpTools: [],
      deferredBuiltinTools: [],
      systemTools: [],
      systemPromptSections: [],
      agents: init.agents.map((agent) => ({
        agentType: agent.name,
        source: 'init',
        tokens: Math.ceil(agent.description.length / 4),
      })),
      slashCommands: {
        totalCommands: init.commands.length,
        includedCommands: init.commands.length,
        tokens: init.commands.reduce((sum, command) => sum + Math.ceil((command.name.length + command.description.length) / 4), 0),
      },
      skills: {
        totalSkills: this.skillRegistry.getUserInvocable().length,
        includedSkills: this.skillRegistry.getUserInvocable().length,
        tokens: this.skillRegistry.getUserInvocable().reduce((sum, skill) => sum + Math.ceil((skill.name.length + skill.description.length) / 4), 0),
        skillFrontmatter: this.skillRegistry.getUserInvocable().map((skill) => ({
          name: skill.name,
          source: 'runtime',
          tokens: Math.ceil((skill.name.length + skill.description.length) / 4),
        })),
      },
      messageBreakdown: {
        toolCallTokens: 0,
        toolResultTokens: 0,
        attachmentTokens: 0,
        assistantMessageTokens: 0,
        userMessageTokens: 0,
        toolCallsByType: [],
        attachmentsByType: [],
      },
      isAutoCompactEnabled: true,
      apiUsage: null,
    }
  }

  private collectMcpServerStatuses(): MCPServerStatus[] {
    const configs = this.getConfiguredMcpServers()
    return Object.entries(configs).map(([name, config]) => {
      const live = this.mcpLinks.find((conn) => conn.name === name)
      return {
        name,
        status: this.disabledMcpServers.has(name)
          ? 'disconnected'
          : live?.status || 'disconnected',
        enabled: !this.disabledMcpServers.has(name),
        tools: live?.tools.map((tool) => tool.name) || (isSdkServerConfig(config)
          ? config.tools.map((tool) => tool.name)
          : []),
        error: live?.error,
      }
    })
  }

  async mcpServerStatus(): Promise<MCPServerStatus[]> {
    await this.setupDone
    return this.collectMcpServerStatuses()
  }

  async setMcpServers(
    servers: Record<string, McpServerConfig | any>,
  ): Promise<{ added: string[]; removed: string[]; errors: Record<string, string> }> {
    await this.setupDone

    const previous = new Set(Object.keys(this.cfg.mcpServers || {}))
    const next = new Set(Object.keys(servers))
    const added = [...next].filter((name) => !previous.has(name))
    const removed = [...previous].filter((name) => !next.has(name))
    const errors: Record<string, string> = {}

    this.cfg.mcpServers = { ...servers }
    for (const name of removed) {
      this.disabledMcpServers.delete(name)
    }

    await this.syncMcpConnections()
    await this.rebuildToolPool()

    for (const status of this.collectMcpServerStatuses()) {
      if (status.status === 'error' && status.error) {
        errors[status.name] = status.error
      }
    }

    return { added, removed, errors }
  }

  async reconnectMcpServer(serverName: string): Promise<MCPServerStatus | null> {
    await this.setupDone
    this.disabledMcpServers.delete(serverName)
    await this.syncMcpConnections()
    await this.rebuildToolPool()
    return this.collectMcpServerStatuses().find((status) => status.name === serverName) || null
  }

  async toggleMcpServer(serverName: string, enabled: boolean): Promise<MCPServerStatus | null> {
    await this.setupDone
    if (enabled) {
      this.disabledMcpServers.delete(serverName)
    } else {
      this.disabledMcpServers.add(serverName)
    }
    await this.syncMcpConnections()
    await this.rebuildToolPool()
    return this.collectMcpServerStatuses().find((status) => status.name === serverName) || null
  }

  async reloadPlugins(): Promise<ReloadPluginsResult> {
    await this.setupDone

    this.loadedPlugins = await loadPlugins(this.cfg.cwd || process.cwd(), this.cfg.plugins)
    this.registerPluginSkills()
    await this.registerFilesystemSkills({
      cwd: this.cfg.cwd || process.cwd(),
      roots: this.cfg.skillsDirectories,
      shouldLoadSkill: this.cfg.shouldLoadFilesystemSkill,
    })
    this.registerExplicitSkills()
    this.loadedCommands = [
      ...(await loadCommandDefinitions(this.cfg.cwd || process.cwd())),
      ...this.getPluginCommands(),
    ]
    this.resetHookRegistry()
    await this.syncMcpConnections()
    await this.rebuildToolPool()

    const mergedAgents = {
      ...this.getPluginAgents(),
      ...(this.cfg.agents || {}),
    }
    if (Object.keys(mergedAgents).length > 0) {
      registerAgents(mergedAgents)
    }

    return {
      commands: (await this.getInitializationResult()).commands,
      agents: Object.entries(mergedAgents).map(([name, agent]) => ({
        name,
        description: agent.description,
      })),
      plugins: this.loadedPlugins.map((plugin) => ({
        name: plugin.name,
        path: plugin.path,
        source: plugin.source,
      })),
      mcpServers: this.collectMcpServerStatuses(),
      error_count: this.collectMcpServerStatuses().filter((status) => status.status === 'error').length,
    }
  }

  async rewindFiles(
    userMessageId: string,
    dryRun = false,
  ): Promise<RewindFilesResult> {
    await this.setupDone
    const checkpoint = this.fileCheckpointState[userMessageId]
    const result = await rewindCheckpoint(checkpoint, dryRun)
    if (!dryRun && result.canRewind) {
      await saveSession(this.sid, this.history, {
        cwd: this.cfg.cwd || process.cwd(),
        model: this.modelId,
        summary: extractSummary(this.messageLog),
        sessionMessages: this.sessionMessages,
        checkpoints: this.fileCheckpointState,
      })
    }
    return result
  }

  async close(): Promise<void> {
    await this.setupDone.catch(() => undefined)

    if (this.cfg.persistSession !== false && this.history.length > 0) {
      try {
        await saveSession(this.sid, this.history, {
          cwd: this.cfg.cwd || process.cwd(),
          model: this.modelId,
          summary: extractSummary(this.messageLog),
          sessionMessages: this.sessionMessages,
          checkpoints: this.fileCheckpointState,
        })
      } catch {
        // Session persistence is best-effort.
      }
    }

    try {
      await closeAllConnections(this.mcpLinks)
    } finally {
      this.mcpLinks = []
      this.unregisterFileSkills()
      this.unregisterExplicitSkills()
      this.unregisterPluginSkills()
    }
  }
}

export function createAgent(options: AgentOptions = {}): Agent {
  return new Agent(options)
}

export function query(params: {
  prompt: QueryInput | AsyncIterable<QueryInput>
  options?: AgentOptions
}): QueryHandle {
  const ephemeral = createAgent(params.options)
  return (ephemeral as any).buildQueryHandle(
    params.prompt,
    undefined,
    async () => {
      await ephemeral.close()
    },
  ) as QueryHandle
}
