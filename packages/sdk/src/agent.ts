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
  Message,
  PermissionMode,
  Query as QueryHandle,
  QueryResult,
  SDKMessage,
  SDKUserMessage,
  SessionMessage,
  SlashCommand,
  ToolDefinition,
  CanUseToolFn,
  ContentBlockParam,
} from './types.js'
import { QueryEngine } from './engine.js'
import { createPersistScheduler } from './persist-scheduler.js'
import { FileStateCache } from './utils/fileCache.js'
import {
  CORE_TOOL_NAMES,
  filterTools,
  getAllBaseTools,
} from './tools/index.js'
import { applyOverrides, createToolRegistry } from './tools/registry.js'
import {
  saveSession,
  loadSession,
  listSessions,
  forkSession as forkStoredSession,
  sliceSessionMessages,
} from './session.js'
import { createHookRegistry, type HookRegistry } from './hooks.js'
import {
  getAllSkills,
  initBundledSkills,
  SkillRegistry,
} from './skills/index.js'
import { createSkillTool } from './tools/skill-tool.js'
import type { LLMProvider, ApiType, NormalizedMessageParam } from './providers/types.js'
import { isUnconfiguredProvider, unconfiguredProvider } from './providers/unconfigured-provider.js'
import {
  loadSettingsFromSources,
  mergeAgentOptions,
  type LoadedSettingsSource,
} from './utils/settings.js'
import { QueryController } from './query-controller.js'
import { loadFilesystemSkills } from './skills/fs-loader.js'
import type { FileCheckpoint, FileCheckpointState } from './utils/file-checkpoints.js'
import { getContextWindowSize } from './utils/tokens.js'
import { matchesAnyToolPattern } from './utils/tool-approval.js'
import { createExecuteTool, createToolSearchTool, isToolSearchEnabled, setDeferredTools } from './tools/tool-search.js'
import { detectDanglingToolUses, INTERRUPTED_TOOL_PLACEHOLDER } from './interrupt-recovery.js'

type QueryInput = string | ContentBlockParam[] | SDKUserMessage

function toSessionMessage(
  role: SessionMessage['role'],
  content: unknown,
  uuid?: string,
): SessionMessage {
  return {
    uuid: uuid ?? crypto.randomUUID(),
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

function extractSummary(messages: Message[]): string | undefined {
  const lastAssistant = [...messages].reverse().find((message) => message.type === 'assistant')
  if (!lastAssistant) return undefined

  return lastAssistant.message.content
    .filter((block: any) => block.type === 'text')
    .map((block: any) => block.text)
    .join('\n')
    .slice(0, 500) || undefined
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

function isCompactionSummaryMessage(message: NormalizedMessageParam): boolean {
  return Array.isArray(message.content)
    && message.content.some((block: any) =>
      block?.type === 'text' && block?._meta?.contextBlock === 'compaction')
}

/**
 * messageLog 不再独立维护：由 sessionMessages 按出处投影重建。
 * 仅两处 live 写入点登记 uuid（user 提交 / assistant 事件），因此
 * compaction 摘要、continuation 注入、tool_result 载体等合成条目
 * 天然不入日志，无需内容嗅探。
 */
function isLoggedAssistantContent(content: unknown): boolean {
  return Boolean(
    content
    && typeof content === 'object'
    && !Array.isArray(content)
    && (content as { role?: unknown }).role === 'assistant',
  )
}

function wrapAssistantLogMessage(content: unknown): Extract<Message, { type: 'assistant' }>['message'] {
  if (isLoggedAssistantContent(content)) {
    return content as Extract<Message, { type: 'assistant' }>['message']
  }
  return { role: 'assistant', content } as Extract<Message, { type: 'assistant' }>['message']
}

export function sessionMessagesFromHistory(
  messages: NormalizedMessageParam[],
  previous?: SessionMessage[],
): SessionMessage[] {
  // Realign with the previous list so rebuilt messages keep their original
  // uuids — fileCheckpointState is keyed by user-message uuid, and fresh
  // uuids here would orphan every checkpoint (#363). Alignment pairs each
  // role from the END: compaction prepends a synthetic summary user message,
  // so only the trailing messages correspond 1:1 with what came before.
  // Synthetic summaries never participate in pairing: when the previous list
  // holds more same-role entries than the rebuilt history (the normal
  // compaction shape), tail pairing would hand them a swallowed message's
  // uuid and let rewindFiles restore unrelated snapshots.
  const previousUuidsByRole = new Map<string, string[]>()
  for (const message of previous ?? []) {
    const uuids = previousUuidsByRole.get(message.role) ?? []
    uuids.push(message.uuid)
    previousUuidsByRole.set(message.role, uuids)
  }
  const indicesByRole = new Map<string, number[]>()
  messages.forEach((message, index) => {
    if (isCompactionSummaryMessage(message)) return
    const indices = indicesByRole.get(message.role) ?? []
    indices.push(index)
    indicesByRole.set(message.role, indices)
  })
  const uuidByIndex = new Map<number, string>()
  for (const [role, indices] of indicesByRole) {
    const uuids = previousUuidsByRole.get(role) ?? []
    const paired = Math.min(indices.length, uuids.length)
    for (let offset = 0; offset < paired; offset++) {
      uuidByIndex.set(
        indices[indices.length - paired + offset]!,
        uuids[uuids.length - paired + offset]!,
      )
    }
  }
  return messages.map((message, index) =>
    toSessionMessage(
      message.role as SessionMessage['role'],
      message.content,
      uuidByIndex.get(index),
    ))
}

export class Agent {
  private baseOptions: AgentOptions
  private cfg: AgentOptions
  private toolPool: ToolDefinition[] = []
  private deferredToolPool: ToolDefinition[] = []
  /** Names promoted via ToolSearch; kept eager for this Agent instance's lifetime. */
  private activatedToolNames = new Set<string>()
  private toolRegistry = createToolRegistry()
  private unregisterRuntimeTools: (() => void) | null = null
  private modelId = 'claude-sonnet-4-6'
  private provider: LLMProvider
  /** 消息日志出处集合：resume 载入的历史不计入本进程日志（保持原增量维护语义）。 */
  private loggedMessageUuids = new Set<string>()
  private sessionMessages: SessionMessage[] = []
  /** resume 载入时 json messages 快照：dangling tool_result 的跨轨修补源（json 写先于 jsonl，崩溃窗口内可能更新）。 */
  private resumeStoredMessages: NormalizedMessageParam[] = []
  /** legacy 会话标记：载入时无 sessionMessages 轨，派生源缺载入前缀。 */
  private legacyResumeMode = false
  private setupDone: Promise<void>
  private sid: string
  private abortCtrl: AbortController | null = null
  private currentEngine: QueryEngine | null = null
  /** Synchronous in-flight marker: set at run entry, cleared when the run ends. */
  private runLocked = false
  private hookRegistry: HookRegistry
  private loadedSettings: LoadedSettingsSource[] = []
  private explicitSkillNames = new Set<string>()
  private fileSkillNames = new Set<string>()
  private fileCheckpointState: FileCheckpointState = {}
  /** Thread-level read-state: shared by every engine this Agent creates so the
   *  stale-read guard survives across runs instead of resetting per user
   *  message (#569). Hosts may inject a per-thread instance via
   *  AgentOptions.fileStateCache when they build one Agent per message; without
   *  injection each Agent gets a private cache. 分工：本 cache 只做 mtime/size/
   *  content 新鲜度判定；"须完整读"的产品级门控由宿主侧 ledger 层负责。
   *  In-memory only — after a process restart the guard fails closed (missing
   *  record -> guided re-Read). */
  private fileStateCache: FileStateCache
  private latestUserMessageId: string | undefined
  private lastUsageEngine: QueryEngine | null = null
  private queuedSdkEvents: SDKMessage[] = []
  // Generation marker for the async-event queue: advanced when a run's
  // finally completes. Each run's onAsyncEvent closure captures the value
  // from before its run, so a late background task_notification firing after
  // the host abandoned iteration (or between runs) is recognized as stale and
  // dropped instead of leaking into the next run's event stream.
  private asyncEventEpoch = 0
  private readonly skillRegistry: SkillRegistry

  constructor(options: AgentOptions = {}) {
    this.baseOptions = { ...options }
    this.cfg = { ...options }
    this.fileStateCache = options.fileStateCache ?? new FileStateCache()
    this.sid = this.cfg.sessionId ?? crypto.randomUUID()
    this.provider = unconfiguredProvider()
    this.hookRegistry = createHookRegistry()
    initBundledSkills()
    this.skillRegistry = new SkillRegistry(getAllSkills())
    this.setupDone = this.setup()
    // Keep the original promise for awaiters, but mark it handled so a setup
    // failure nobody awaited yet does not crash as an unhandledRejection.
    this.setupDone.catch(() => {})
  }

  private refreshResolvedConfig(): void {
    this.modelId = this.cfg.model ?? 'claude-sonnet-4-6'
    this.provider = this.cfg.provider ?? unconfiguredProvider()
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

  private buildBaseToolPool(options: AgentOptions = this.cfg): ToolDefinition[] {
    const bindSkillRegistry = (tool: ToolDefinition) => tool.name === 'Skill'
      ? createSkillTool(this.skillRegistry)
      : tool
    const baseTools = getAllBaseTools().map(bindSkillRegistry)
    const raw = options.tools
    let pool: ToolDefinition[]

    if (!raw || (typeof raw === 'object' && !Array.isArray(raw) && 'type' in raw)) {
      pool = [...baseTools]
    } else if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === 'string') {
      pool = filterTools([...baseTools], raw as string[])
    } else {
      pool = [...(raw as ToolDefinition[]).map(bindSkillRegistry)]
    }

    return filterTools(pool, undefined, options.disallowedTools)
  }

  private async rebuildToolPool(options: AgentOptions = this.cfg): Promise<void> {
    // buildBaseToolPool 已按 disallowedTools 过滤；内置 MCP 链移除后无外部工具并入。
    const assembledTools = this.buildBaseToolPool(options)
    const runtimeContext = {
      cwd: options.cwd || process.cwd(),
      sessionId: this.sid,
      permissionMode: options.permissionMode,
      threadType: options.threadType,
    }
    const runtimeTools = options.resolveRuntimeTools
      ? await options.resolveRuntimeTools(assembledTools, runtimeContext)
      : assembledTools
    // Registry is the single source of truth: global pool + default preset core set.
    // Dispose the previous registration so the registry mirrors this full rebuild
    // (tools dropped from runtimeTools must not linger across rebuilds).
    this.unregisterRuntimeTools?.()
    this.unregisterRuntimeTools = this.toolRegistry.global.register(runtimeTools)
    this.toolRegistry.preset("default").setCore([...CORE_TOOL_NAMES])
    const { core, deferred } = this.toolRegistry.agent(this.sid).view().split()
    // Lifetime promotions survive rebuilds: activated names stay eager and never
    // return to the deferred pool. Names no longer present in the pool (e.g. an
    // MCP server removed after promotion) are silently skipped.
    const runtimeByName = new Map(runtimeTools.map((candidate) => [candidate.name, candidate]))
    const activatedPool = [...this.activatedToolNames]
      .map((name) => runtimeByName.get(name))
      .filter((candidate): candidate is ToolDefinition => !!candidate)
    const remainingDeferred = deferred.filter((candidate) => !this.activatedToolNames.has(candidate.name))
    const enableToolSearch = isToolSearchEnabled(remainingDeferred, options.model || this.modelId)
    this.deferredToolPool = enableToolSearch ? remainingDeferred : []
    setDeferredTools(this.deferredToolPool)
    if (this.deferredToolPool.length === 0) {
      this.toolPool = runtimeTools
      return
    }

    const generatedTools = [
      createToolSearchTool(() => this.deferredToolPool),
      createExecuteTool(() => this.deferredToolPool),
    ]
    await options.registerGeneratedRuntimeTools?.(generatedTools, runtimeContext)
    // Activated tools are appended after the eager prefix so each query's
    // previously-sent tool list stays a stable prefix (prompt-cache friendly).
    this.toolPool = [...core, ...generatedTools, ...activatedPool]
  }

  /**
   * Record a native promotion reported by the engine and mirror it into the
   * live pools immediately (match order), so the next query keeps the tool
   * without waiting for a full pool rebuild.
   */
  private recordToolActivation(names: string[]): void {
    for (const name of names) this.activatedToolNames.add(name)
    // Append in match order (names order) to mirror the engine-side promotion
    // order; deferred registration order would reorder the batch at the query
    // boundary and break the prompt-cache prefix.
    const promoted = names
      .map((name) => this.deferredToolPool.find((candidate) => candidate.name === name))
      .filter((candidate): candidate is ToolDefinition => !!candidate)
    if (promoted.length === 0) return
    this.toolPool = [...this.toolPool, ...promoted]
    const nameSet = new Set(names)
    this.deferredToolPool = this.deferredToolPool.filter((candidate) => !nameSet.has(candidate.name))
    setDeferredTools(this.deferredToolPool)
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

    this.sessionMessages = resumedSessionMessages.length > 0
      ? resumedSessionMessages
      : (sessionData.sessionMessages || [])
    this.resumeStoredMessages = sessionData.messages ?? []
    this.legacyResumeMode = this.sessionMessages.length === 0
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

    await this.refreshCwdDependentState()
    await this.resumeSessionIfNeeded()
    await this.rebuildToolPool()
  }

  /**
   * Reload state derived from cfg.cwd: resolved provider config and skills.
   * Runs from setup() and again after setCwd(). Must not rebuild cfg
   * (runtime mutations like setModel or setPermissionMode live there) nor
   * re-run the session resume/fork branch.
   */
  private async refreshCwdDependentState(): Promise<void> {
    const cwd = this.cfg.cwd || process.cwd()
    this.refreshResolvedConfig()
    await this.registerFilesystemSkills({
      cwd,
      roots: this.cfg.skillsDirectories,
      shouldLoadSkill: this.cfg.shouldLoadFilesystemSkill,
    })
    this.registerExplicitSkills()
    this.resetHookRegistry()
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

    return async (tool, input, metadata) => {
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
        if (tool.isReadOnly?.(input) || readOnlyNames.has(tool.name)) {
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
        if (tool.isReadOnly?.(input) || readOnlyNames.has(tool.name) || editNames.has(tool.name) || tool.name === 'TaskStop') {
          return { behavior: 'allow', ...base }
        }
        return { behavior: 'deny', message: `Tool "${tool.name}" is not allowed in acceptEdits mode.`, ...base }
      }

      if (permMode === 'default') {
        if (tool.isReadOnly?.(input) || readOnlyNames.has(tool.name)) {
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
    if (opts.persistSession === false || this.getPersistedHistory().length === 0) {
      return null
    }

    try {
      await saveSession(this.sid, this.getPersistedHistory(), {
        cwd,
        model: opts.model || this.modelId,
        summary: extractSummary(this.getMessages()),
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

  /** Resolve the tool pools for one run: shared by runSinglePrompt and resumeInterruptedRun. */
  private getRunTools(
    _opts: AgentOptions,
    overrides?: Partial<AgentOptions>,
  ): { tools: ToolDefinition[]; deferredTools: ToolDefinition[] } {
    if (!overrides?.disallowedTools && !overrides?.tools) {
      return { tools: this.toolPool, deferredTools: this.deferredToolPool }
    }
    // One-shot registry masks: evaluate the masked snapshot, then restore.
    const masked = applyOverrides(this.toolRegistry, this.sid, overrides, {
      tools: this.toolPool,
      deferredTools: this.deferredToolPool,
    })
    masked.undo()
    return { tools: masked.tools, deferredTools: masked.deferredTools }
  }

  private async *runSinglePrompt(
    prompt: QueryInput,
    overrides?: Partial<AgentOptions>,
  ): AsyncGenerator<SDKMessage, void> {
    // A synchronous flag closes the TOCTOU window: the engine assignment sits
    // several awaits deep, so two lazily-started queries could both pass a
    // pure currentEngine check and fork the same session into two engines (#357).
    if (this.runLocked || this.currentEngine) throw new Error('agent is running')
    this.runLocked = true
    try {
      yield* this.runSinglePromptLocked(prompt, overrides)
    } finally {
      this.runLocked = false
    }
  }

  private async *runSinglePromptLocked(
    prompt: QueryInput,
    overrides?: Partial<AgentOptions>,
  ): AsyncGenerator<SDKMessage, void> {
    // currentEngine (not abortCtrl, which is never cleared after a run) is
    // the accurate in-flight marker: set before the loop, cleared in finally.
    await this.setupDone

    // Fail fast before any listener is attached, the user message is
    // persisted, or a run is set up: a missing provider must reject the
    // prompt() call, not surface as a silent empty-success result event.
    // The legacy credential keys are typed away in AgentOptions but still
    // checked at runtime so pre-contract hosts get a clear error instead
    // of silently ignored options.
    const legacyOverrideKeys = overrides as Record<string, unknown> | undefined
    if (
      overrides?.provider ||
      legacyOverrideKeys?.apiType ||
      legacyOverrideKeys?.apiKey ||
      legacyOverrideKeys?.baseURL
    ) {
      throw new Error(
        'Per-run provider overrides are no longer supported. Pass options.provider to createAgent() instead.',
      )
    }
    if (isUnconfiguredProvider(this.provider)) {
      throw new Error(
        'No LLMProvider configured. Pass options.provider to createAgent() — the SDK ships no built-in HTTP providers.',
      )
    }

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

    // Crash repair: message-level persistence can leave the trailing assistant
    // tool_use without a tool_result (a crashed run has no abort placeholders).
    // Sending that history to the provider is rejected, deadlocking the thread.
    // Fill error placeholders here so the next request is well-formed. Skipped
    // when toolContinuations carry the boundary (resumeInterruptedRun etc.) —
    // the engine's result-side idempotency covers those paths.
    if (!opts.toolContinuations?.length) {
      this.repairDanglingToolUses()
    }

    const abortCtrl = opts.abortController || new AbortController()
    this.abortCtrl = abortCtrl

    // Message-level throttled persistence: collapse bursts of message events
    // into one write so a crash loses at most the debounce window, not the run.
    // The finally block below flushes whatever is still pending.
    const persistScheduler = createPersistScheduler(200, () =>
      this.persistCurrentSession(cwd, opts).then(() => undefined))
    // The host may reuse one session-level AbortSignal across many runs; detach
    // the forwarder when this run ends so listeners don't pile up on it (#244).
    const forwardAbort = () => abortCtrl.abort(opts.abortSignal?.reason)
    if (opts.abortSignal) {
      if (opts.abortSignal.aborted) {
        abortCtrl.abort(opts.abortSignal.reason)
      } else {
        opts.abortSignal.addEventListener('abort', forwardAbort, { once: true })
      }
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


    const { tools, deferredTools } = this.getRunTools(opts, overrides)

    const provider = this.provider

    const normalizedPrompt = normalizePromptInput(prompt)
    const modelFacingPrompt = normalizedPrompt
    const isManualCompactCommand = typeof normalizedPrompt === 'string' && normalizedPrompt.trim() === '/compact'
    // 本轮输入入轨前的哨位：seed 派生只取哨位之前的历史，本轮输入由引擎自行追加，
    // 否则派生视图与引擎各带一份造成请求重复（#297-④ 单一历史）。
    const preRunInputCount = this.sessionMessages.length
    const runtimeMessage = !isManualCompactCommand && opts.runtimeContext?.trim()
      ? toSessionMessage('runtime', opts.runtimeContext.trim())
      : null
    const userMessage = isManualCompactCommand || opts.toolContinuations?.length
      ? null
      : toSessionMessage('user', normalizedPrompt)
    if (runtimeMessage) {
      this.sessionMessages.push(runtimeMessage)
    }
    if (userMessage) {
      this.latestUserMessageId = userMessage.uuid
      this.sessionMessages.push(userMessage)
      this.loggedMessageUuids.add(userMessage.uuid)
      await this.persistCurrentSession(cwd, opts)
    }

    // Captured before the engine exists: once this run's finally advances the
    // epoch, closures holding the stale value are recognized as dead runs'.
    const sdkEventEpoch = this.asyncEventEpoch
    const engine = new QueryEngine({
      cwd,
      model: opts.model || this.modelId,
      provider,
      tools,
      deferredTools,
      onToolsActivated: (names) => this.recordToolActivation(names),
      systemPrompt,
      runtimeContext: runtimeMessage ? opts.runtimeContext?.trim() : undefined,
      promptCache: opts.promptCache,
      appendSystemPrompt,
      maxTurns: opts.maxTurns ?? 10,
      maxBudgetUsd: opts.maxBudgetUsd,
      maxTokens: opts.maxTokens ?? 16384,
      contextWindow: opts.contextWindow,
      thinking: opts.thinking,
      jsonSchema: opts.jsonSchema,
      outputFormat: opts.outputFormat,
      effort: opts.effort,
      canUseTool: this.getCanUseTool(opts),
      includePartialMessages: opts.includePartialMessages ?? false,
      abortSignal: this.abortCtrl.signal,
      agents: {
        ...(opts.agents || {}),
      },
      hookRegistry: this.hookRegistry,
      sessionId: this.sid,
      runId: opts.runId,
      subagentRunId: opts.subagentRunId,
      toolContinuations: opts.toolContinuations,
      permissionMode: opts.permissionMode,
      promptSuggestions: opts.promptSuggestions,
      additionalDirectories: opts.additionalDirectories,
      skillRegistry: this.skillRegistry,
      initialization: {
        slashCommands: this.getInitializationCommands().map((command) => command.name),
        skills: this.skillRegistry.getUserInvocable().map((skill) => skill.name),
        outputStyle: opts.outputStyle || 'text',
        claudeCodeVersion: 'open-agent-sdk/0.2.0',
        apiKeySource: 'configured',
      },
      sandbox: opts.sandbox,
      toolConfig: opts.toolConfig,
      artifactsRoot: opts.artifactsRoot,
      onToolExecution: opts.onToolExecution,
      onBeforeToolExecution: opts.onBeforeToolExecution,
      onAsyncEvent: (event) => {
        if (opts.onAsyncEvent) {
          opts.onAsyncEvent(event)
          return
        }
        if (sdkEventEpoch !== this.asyncEventEpoch) return
        this.queuedSdkEvents.push(event)
      },
      onLiveEvent: opts.onLiveEvent,
      // Continuation runs produce no user message; derive the checkpoint key
      // from the first dangling tool_use id so each resumed run gets its own
      // baseline instead of polluting a shared per-session bucket.
      currentUserMessageId: userMessage?.uuid ?? (opts.toolContinuations?.length
        ? `continuation:${opts.toolContinuations[0]!.toolCall.id}`
        : `command:${this.sid}:compact`),
      fileCheckpointState: this.fileCheckpointState,
      fileStateCache: this.fileStateCache,
      enableFileCheckpointing: opts.enableFileCheckpointing === true,
      contextController: opts.contextController,
      completionGuard: opts.completionGuard,
    })
    this.currentEngine = engine

    for (const msg of this.buildRunHistory(preRunInputCount)) {
      engine.messages.push(msg)
    }

    for (const queued of this.drainQueuedSdkEvents()) {
      yield queued
    }

    // No auth_status event: the entry check above guarantees a host-injected
    // provider, the SDK owns no credentials, and no consumer ever read this
    // event — it was pure dead weight on every run.

    let persistedSessionEvent: SDKMessage | null = null
    let compactionBoundarySeen = false
    let runCompleted = false
    try {
      for await (const event of engine.submitMessage(modelFacingPrompt)) {
        if (event.type === 'assistant') {
          const assistantMessage = toSessionMessage('assistant', event.message)
          this.sessionMessages.push(assistantMessage)
          this.loggedMessageUuids.add(assistantMessage.uuid)
          persistScheduler.schedule()
        } else if (event.type === 'tool_result') {
          // _meta 白名单投影（#567 第 5 项）：整包透传会把工具私有元数据带进
          // 持久权威轨，但全丢会让 computer-use 台账跨 run 清零、provider 侧
          // toolName 降级为 "tool"。只携带跨 run 有消费方的最小集合。
          const projectedMeta = event.result._meta as Record<string, unknown> | undefined
          const whitelistedMeta = projectedMeta ? {
            ...(projectedMeta.computerUseAction !== undefined ? { computerUseAction: projectedMeta.computerUseAction } : {}),
            ...(projectedMeta.toolName !== undefined ? { toolName: projectedMeta.toolName } : {}),
          } : undefined
          this.sessionMessages.push(toSessionMessage('user', [{
            type: 'tool_result',
            tool_use_id: event.result.tool_use_id,
            tool_name: event.result.tool_name,
            content: event.result.content ?? event.result.output,
            is_error: event.result.is_error === true,
            ...(whitelistedMeta && Object.keys(whitelistedMeta).length > 0 ? { _meta: whitelistedMeta } : {}),
          }]))
          persistScheduler.schedule()
        } else if (event.type === 'system') {
          this.sessionMessages.push(toSessionMessage('system', event))
          if (event.subtype === 'compact_boundary') {
            compactionBoundarySeen = true
          }
          persistScheduler.schedule()
        }

        yield event
        for (const queued of this.drainQueuedSdkEvents()) {
          yield queued
        }
      }
      runCompleted = true
    } finally {
      if (!runCompleted) {
        // Consumer abandoned the generator mid-run (break / close): pending
        // async events can no longer be delivered and must not leak into the
        // next run's event stream.
        this.queuedSdkEvents.length = 0
      }
      // Drop any pending debounced write and wait out one already in flight:
      // the awaited persistCurrentSession below writes the same (or fresher)
      // state. Flushing here instead would launch a concurrent fire-and-forget
      // saveSession that races with both the awaited write and readers of the
      // session file.
      await persistScheduler.cancel()
      opts.abortSignal?.removeEventListener('abort', forwardAbort)
      const finalEngineMessages = engine.getMessages()
      // Keep only the engine reference: the full token estimation runs
      // lazily when a host actually calls getContextUsage (#386).
      this.lastUsageEngine = engine
      this.currentEngine = null
      // Invalidate this run's async-event closures: anything they enqueue from
      // here on is post-run residue (late background task_notification after
      // the host stopped iterating) and must not survive into the next run's
      // drain windows.
      this.asyncEventEpoch++
      // compaction 重写与 continuation 注入只存在于引擎视图：把权威轨
      // 对齐回引擎真值（尾配对保 uuid，#363）。
      if (compactionBoundarySeen || opts.toolContinuations?.length) {
        this.sessionMessages = sessionMessagesFromHistory(finalEngineMessages, this.sessionMessages)
      }
      persistedSessionEvent = await this.persistCurrentSession(cwd, opts)
    }

    // Drain before the final yields: once the consumer stops iterating, the
    // queue must be empty either way — leftover async events belong to this
    // dead run, not the next one.
    const tailQueued = this.drainQueuedSdkEvents()
    if (persistedSessionEvent) {
      yield persistedSessionEvent
    }
    for (const queued of tailQueued) {
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

    return new QueryController(runner, initialInput)
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
      messages: [...this.getMessages()],
    }
  }

  /**
   * 单一历史(#297-④)：sessionMessages 是唯一权威轨，LLM 请求视图在每次
   * run 前从它派生（含 dangling 修补注入），不再长驻第三份内存拷贝。
   * fromIndex 之前的条目才进入派生视图（本轮输入由引擎自行追加）；
   * system 事件扫描始终用全量 sms。
   */
  private buildRunHistory(fromIndex = 0): NormalizedMessageParam[] {
    return restoreMissingToolResults(
      normalizeHistoryFromSessionMessages(this.sessionMessages.slice(0, fromIndex)),
      this.resumeStoredMessages,
      this.sessionMessages,
    )
  }

  /**
   * transcript.json 的 messages 由 sessionMessages 派生（磁盘单一来源，
   * 与 jsonl 轨同源）；legacy resume 时派生源缺载入前缀，拼接载入快照。
   */
  private getPersistedHistory(): NormalizedMessageParam[] {
    const derived = normalizeHistoryFromSessionMessages(this.sessionMessages)
    return this.legacyResumeMode
      ? [...this.resumeStoredMessages, ...derived]
      : derived
  }

  getMessages(): Message[] {
    const log: Message[] = []
    for (const message of this.sessionMessages) {
      if (!this.loggedMessageUuids.has(message.uuid)) continue
      if (message.role === 'assistant') {
        log.push({
          type: 'assistant',
          message: wrapAssistantLogMessage(message.content),
          uuid: message.uuid,
          timestamp: message.timestamp,
        })
      } else if (message.role === 'user') {
        log.push({
          type: 'user',
          message: { role: 'user', content: message.content } as Extract<Message, { type: 'user' }>['message'],
          uuid: message.uuid,
          timestamp: message.timestamp,
        })
      }
    }
    return log
  }

  clear(): void {
    this.loggedMessageUuids.clear()
    this.sessionMessages = []
    this.resumeStoredMessages = []
    this.legacyResumeMode = false
    this.fileCheckpointState = {}
  }

  async interrupt(): Promise<void> {
    this.abortCtrl?.abort('interrupt')
  }

  /**
   * Fill dangling trailing tool_use blocks with error placeholders so the
   * session is provider-clean. Returns true when sessionMessages changed.
   * 只写权威轨（sessionMessages）：请求视图由 buildRunHistory 派生时自然带上。
   */
  private repairDanglingToolUses(): boolean {
    const dangling = detectDanglingToolUses(this.buildRunHistory())
    if (dangling.length === 0) return false
    const blocks = dangling.map((use) => ({
      type: 'tool_result' as const,
      tool_use_id: use.id,
      content: INTERRUPTED_TOOL_PLACEHOLDER,
      is_error: true,
    }))
    this.sessionMessages.push(toSessionMessage('user', blocks))
    return true
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
    // Refresh cwd-derived state only: a full setup() would rebuild cfg from
    // settings (reverting runtime changes like setModel) and re-run the resume
    // branch (silently forking a resumed session a second time).
    this.setupDone = this.refreshCwdDependentState().then(() => this.rebuildToolPool())
    this.setupDone.catch(() => {})
    await this.setupDone
  }

  getSessionId(): string {
    return this.sid
  }

  /** Resolved API type of the active (host-injected or fallback) provider config. */
  getApiType(): ApiType {
    return this.provider.apiType
  }

  private getInitializationCommands(): SlashCommand[] {
    const builtins: SlashCommand[] = [
      { name: '/clear', description: 'Clear the current conversation context' },
      { name: '/compact', description: 'Compact the current conversation history' },
      { name: '/resume', description: 'Resume a prior session' },
      { name: '/mcp', description: 'Inspect MCP server status' },
      { name: '/reload-plugins', description: 'Reload plugins from disk' },
    ]
    return builtins
  }

  async getInitializationResult(): Promise<InitializationResult> {
    await this.setupDone

    const commands = this.getInitializationCommands()
    // Reflect the host provider injection, not legacy apiKey fields: the
    // provider carries credentials now, so an injected provider IS the
    // configured credential source.
    const credentialSource = isUnconfiguredProvider(this.provider)
      ? 'missing'
      : 'configured'

    return {
      commands,
      agents: Object.entries({
        ...(this.cfg.agents || {}),
      }).map(([name, agent]) => ({
        name,
        description: agent.description,
      })),
      output_style: 'text',
      available_output_styles: ['text', 'json', 'streamlined'],
      models: [],
      account: {
        tokenSource: credentialSource,
        apiKeySource: credentialSource,
      },
      slash_commands: commands.map((command) => command.name),
      skills: this.skillRegistry.getUserInvocable().map((skill) => skill.name),
    }
  }

  async getContextUsage(): Promise<ContextUsageResult> {
    await this.setupDone
    if (this.currentEngine) {
      return this.currentEngine.getContextUsage()
    }
    if (this.lastUsageEngine) {
      return this.lastUsageEngine.getContextUsage()
    }
    const init = await this.getInitializationResult()
    return {
      categories: [
        { name: 'messages', tokens: 0 },
        { name: 'system', tokens: 0 },
        { name: 'tools', tokens: 0 },
      ],
      totalTokens: 0,
      maxTokens: getContextWindowSize(this.modelId),
      rawMaxTokens: getContextWindowSize(this.modelId),
      percentage: 0,
      model: this.modelId,
      memoryFiles: [],
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

  /** Return the checkpoint captured for the most recently submitted user message. */
  getLatestFileCheckpoint(): FileCheckpoint | undefined {
    return this.latestUserMessageId ? this.fileCheckpointState[this.latestUserMessageId] : undefined
  }

  async close(): Promise<void> {
    await this.setupDone.catch(() => undefined)

    const persistedHistory = this.getPersistedHistory()
    if (this.cfg.persistSession !== false && persistedHistory.length > 0) {
      try {
        await saveSession(this.sid, persistedHistory, {
          cwd: this.cfg.cwd || process.cwd(),
          model: this.modelId,
          summary: extractSummary(this.getMessages()),
          sessionMessages: this.sessionMessages,
          checkpoints: this.fileCheckpointState,
        })
      } catch {
        // Session persistence is best-effort.
      }
    }

    this.unregisterFileSkills()
    this.unregisterExplicitSkills()
    // Release the engine retained for lazy usage estimation (#386): past
    // close, it would otherwise keep the full message history reachable for
    // the lifetime of the Agent. getContextUsage falls back to the safe
    // zero-value shape.
    this.lastUsageEngine = null
  }
}

export function createAgent(options: AgentOptions = {}): Agent {
  return new Agent(options)
}
