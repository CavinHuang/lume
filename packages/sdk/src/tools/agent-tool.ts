/**
 * AgentTool - Spawn subagents for parallel/delegated work
 *
 * Supports built-in agents (Explore, Plan) and custom agent definitions.
 * Agents run as nested query loops with their own context and tool sets.
 */

import type { ToolDefinition, ToolContext, ToolResult, AgentDefinition, SDKMessage } from '../types.js'
import { QueryEngine } from '../engine.js'
import { createProvider, type ApiType } from '../providers/index.js'
import { loadSession } from '../session.js'
import { finalizeSubagentOutputFromState, summarizeSubagentAssistantEvent } from './subagent-output.js'
import { annotateSubagentStreamingEvent } from './agent-tool-events.js'
import { getSkill } from '../skills/registry.js'
import { recordSkillUsage } from '../skills/evolution.js'
import { createProcessJobRecord, unregisterProcessStopHandler, updateProcessJob, type ProcessJob } from './process-job-registry.js'
import { createManagedWorktree, removeManagedWorktree, type ManagedWorktree } from './worktree-tools.js'

// Store for registered agent definitions
let registeredAgents: Record<string, AgentDefinition> = {}

const TASK_MANAGEMENT_TOOL_NAMES = new Set([
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet',
  'TaskStop',
  'TaskOutput',
  'ProcessOutput',
  'ProcessStop',
])

/**
 * Register agent definitions for the AgentTool to use.
 */
export function registerAgents(agents: Record<string, AgentDefinition>): void {
  registeredAgents = { ...registeredAgents, ...agents }
}

/**
 * Clear registered agents.
 */
export function clearAgents(): void {
  registeredAgents = {}
}

/**
 * Built-in agent definitions.
 */
const BUILTIN_AGENTS: Record<string, AgentDefinition> = {
  Explore: {
    description: 'Fast agent for exploring codebases. Use for finding files, searching code, and answering questions about the codebase.',
    prompt: 'You are a codebase exploration agent. Search through files and code to answer questions. Be thorough but efficient. Use Glob to find files, Grep to search content, and Read to examine files.',
    tools: ['Read', 'Glob', 'Grep', 'Bash'],
  },
  Plan: {
    description: 'Software architect agent for designing implementation plans. Returns step-by-step plans and identifies critical files.',
    prompt: 'You are a software architect. Design implementation plans for the given task. Identify critical files, consider trade-offs, and provide step-by-step plans. Use search tools to understand the codebase before planning.',
    tools: ['Read', 'Glob', 'Grep', 'Bash'],
  },
}

export const AgentTool: ToolDefinition = {
  name: 'Agent',
  description: 'Launch a new agent to handle complex, multi-step tasks. Each agent has its own context and tool set. IMPORTANT: When tasks are independent, produce MULTIPLE Agent tool_use calls in a single response — they will execute in parallel automatically. Each call waits for its subagent result.',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'The task for the agent to perform',
      },
      description: {
        type: 'string',
        description: 'A short (3-5 word) description of the task',
      },
      subagent_type: {
        type: 'string',
        description: 'The type of agent to use (e.g., "Explore", "Plan", or a custom agent name)',
      },
      subagent_id: {
        type: 'string',
        description: 'Optional persistent subagent Session ID to reuse for this task',
      },
      task_id: {
        type: 'string',
        description: 'Optional persistent task ID to continue or reassign',
      },
      new_task: {
        type: 'boolean',
        description: 'Must be true when creating independent work without task_id. Never copy a raw user continuation message into prompt.',
      },
      acceptance_criteria: {
        type: 'array',
        items: { type: 'string' },
        description: 'Acceptance criteria for a newly created persistent task',
      },
      expected_artifacts: {
        type: 'array',
        items: { type: 'string' },
        description: 'Expected files or other artifacts for a newly created persistent task',
      },
      task_ref: {
        type: 'object',
        description: 'Associate an independently-created executor with a claimed main-agent Task. This is mutually exclusive with legacy coordinator fields.',
        required: ['taskListId', 'taskId', 'claimToken'],
        properties: {
          taskListId: { type: 'string' },
          taskId: { type: 'string' },
          claimToken: { type: 'string' },
        },
      },
      model: {
        type: 'string',
        description: 'Optional model override for this agent',
      },
      max_turns: {
        type: 'number',
        description: 'Optional max turn override for this agent',
      },
      resume: {
        type: 'string',
        description: 'Optional session ID to resume for this subagent',
      },
      name: {
        type: 'string',
        description: 'Name for the spawned agent',
      },
      team_name: {
        type: 'string',
        description: 'Optional team name used to group or label the spawned agent',
      },
      mode: {
        type: 'string',
        enum: ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'],
        description: 'Permission mode for the spawned agent',
      },
      cwd: {
        type: 'string',
        description: 'Optional working directory override for the spawned agent',
      },
      run_in_background: {
        type: 'boolean',
        description: 'Run the subagent in the background and return a task ID immediately',
      },
      isolation: {
        type: 'string',
        enum: ['none', 'worktree'],
        description: 'Optional execution isolation. worktree creates a temporary git worktree.',
      },
      subagent_run_id: {
        type: 'string',
        description: 'Internal run id injected by the host runtime. Reused across task events and finalization.',
      },
    },
    required: ['prompt', 'description'],
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
  validateInput(input) {
    if (!input || typeof input !== 'object') return 'Input must be an object.'
    if (typeof input.prompt !== 'string' || !input.prompt.trim()) return 'prompt is required.'
    if (typeof input.description !== 'string' || !input.description.trim()) return 'description is required.'
    if (input.isolation !== undefined && !['none', 'worktree'].includes(input.isolation)) return 'Only none and worktree isolation are supported.'
    if (input.run_in_background !== undefined && typeof input.run_in_background !== 'boolean') return 'run_in_background must be a boolean.'
  },
  async prompt() {
    return 'Launch a subagent to handle complex tasks autonomously.'
  },
  async call(input: any, context: ToolContext): Promise<ToolResult> {
    if (input?.isolation !== undefined && !['none', 'worktree'].includes(input.isolation)) {
      return { type: 'tool_result', tool_use_id: '', content: 'Invalid input for tool "Agent": Only none and worktree isolation are supported.', is_error: true }
    }
    const { getAllBaseTools, filterTools, splitDeferredTools } = await import('./index.js')
    const { createExecuteTool, createToolSearchTool, isToolSearchEnabled } = await import('./tool-search.js')
    const agentType = input.subagent_type || 'general-purpose'
    let effectiveCwd = input.cwd || context.cwd

    // Find agent definition
    const agentDef = registeredAgents[agentType] || BUILTIN_AGENTS[agentType]

    const defaultSkill = agentDef?.defaultSkillName
      ? context.skillRegistry?.get(agentDef.defaultSkillName) ?? getSkill(agentDef.defaultSkillName)
      : undefined

    // Determine tools for subagent
    let tools = getAllBaseTools()
    if (agentDef?.tools) {
      tools = filterTools(tools, agentDef.tools)
    }
    if (agentDef?.disallowedTools) {
      tools = filterTools(tools, undefined, agentDef.disallowedTools)
    }
    if (defaultSkill?.allowedTools?.length) {
      tools = filterTools(tools, defaultSkill.allowedTools)
    }

    // Remove recursive delegation and all Task/process-management tools from
    // nested SDK subagents. The sidecar applies the same deny set at runtime.
    tools = tools.filter(t => t.name !== 'Agent' && !TASK_MANAGEMENT_TOOL_NAMES.has(t.name))
    const { core, deferred } = splitDeferredTools(tools)
    const deferredTools = isToolSearchEnabled(deferred, input.model || context.model || process.env.CODEANY_MODEL || 'claude-sonnet-4-6')
      ? deferred
      : []
    if (deferredTools.length > 0) {
      tools = [
        ...core,
        createToolSearchTool(() => deferredTools),
        createExecuteTool(() => deferredTools),
      ]
    }

    // Build system prompt
    let systemPrompt = agentDef?.prompt ||
      'You are a helpful assistant. Complete the given task using the available tools.'
    if (defaultSkill) {
      const contentBlocks = await defaultSkill.getPrompt('', {
        ...context,
        cwd: effectiveCwd,
      })
      const skillPrompt = contentBlocks
        .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
        .map((block) => block.text.trim())
        .filter(Boolean)
        .join('\n\n')
      if (skillPrompt) {
        systemPrompt = [
          systemPrompt,
          `Default Skill (${defaultSkill.name})`,
          skillPrompt,
        ].join('\n\n')
      }
      await recordSkillUsage({
        skillName: defaultSkill.name,
        skillPath: defaultSkill.sourcePath,
        sessionId: context.sessionId,
      }).catch(() => undefined)
    }

    // Inherit provider and model from parent agent context, fall back to env vars
    const subModel = input.model || context.model || process.env.CODEANY_MODEL || 'claude-sonnet-4-6'
    const provider = context.provider ?? createProvider(
      (context.apiType || process.env.CODEANY_API_TYPE as ApiType) || 'anthropic-messages',
      {
        apiKey: process.env.CODEANY_API_KEY,
        baseURL: process.env.CODEANY_BASE_URL,
      },
    )

    const agentId = typeof input.subagent_run_id === 'string' && input.subagent_run_id.trim().length > 0
      ? input.subagent_run_id.trim()
      : crypto.randomUUID()

    context.onSubagentStart?.({
      runId: agentId,
      parentThreadId: context.sessionId ?? '',
      agentType: agentType,
      task: input.prompt,
    })

    let subagentStatus: 'completed' | 'errored' | 'aborted' = 'completed'
    let subagentErrorMessage = ''
    let activeAbortSignal = context.abortSignal
    let backgroundTask: ProcessJob | undefined
    let worktree: ManagedWorktree | undefined

    const runSubagent = async () => {
      // Fire SubagentStart hook on the parent's hook registry
      if (context.hookRegistry) {
        const hookResult = await context.hookRegistry.executeDetailed('SubagentStart', {
          event: 'SubagentStart',
          agent_id: agentId,
          agent_type: agentType,
          sessionId: context.sessionId,
        })
        for (const evt of hookResult.events) {
          context.emitEvent?.(evt)
        }
      }

      const engine = new QueryEngine({
        cwd: effectiveCwd,
        model: subModel,
        provider,
        tools,
        deferredTools,
        systemPrompt,
        maxTurns: input.max_turns || agentDef?.maxTurns || 10,
        maxTokens: 16384,
        canUseTool: async (tool) => {
          if (input.mode === 'plan') {
            return { behavior: tool.isReadOnly?.() ? 'allow' : 'deny', message: 'Plan mode subagent is read-only' }
          }
          if (input.mode === 'default') {
            return { behavior: tool.isReadOnly?.() ? 'allow' : 'deny', message: 'Default mode subagent requires explicit approval for mutating tools' }
          }
          return { behavior: 'allow' }
        },
        includePartialMessages: false,
        sessionId: agentId,
        permissionMode: input.mode,
        abortSignal: activeAbortSignal,
      })

      if (input.resume) {
        const sessionData = await loadSession(input.resume)
        if (sessionData?.messages?.length) {
          engine.messages.push(...sessionData.messages)
        }
      }

      let resultText = ''
      let lastAssistantMessage = ''
      const toolCalls: string[] = []

      for await (const event of engine.submitMessage(input.prompt)) {
        if (activeAbortSignal?.aborted) {
          subagentStatus = 'aborted'
          break
        }
        const taggedEvent = annotateSubagentStreamingEvent(event as SDKMessage, {
          subagentRunId: agentId,
          parentSessionId: context.sessionId,
        })
        if (taggedEvent) {
          context.emitEvent?.(taggedEvent)
          if (backgroundTask) {
            context.emitEvent?.({
              type: 'system',
              subtype: 'task_progress',
              task_id: backgroundTask.id,
              description: backgroundTask.subject,
              last_tool_name: event.type === 'tool_result' ? event.result.tool_name : 'Agent',
              usage: { total_tokens: 0, tool_uses: 1, duration_ms: 0 },
              session_id: context.sessionId || '',
            })
          }
        }
        if (event.type === 'assistant') {
          const summary = summarizeSubagentAssistantEvent(
            event.message.content as Array<Record<string, unknown>>,
            resultText,
            toolCalls,
          )
          resultText = summary.textOutput
          lastAssistantMessage = summary.lastAssistantMessage || lastAssistantMessage
          toolCalls.length = 0
          toolCalls.push(...summary.toolCalls)
          continue
        }

        if (event.type === 'result') {
          if (typeof event.result === 'string' && event.result.trim()) {
            resultText = resultText
              ? `${resultText}\n\n${event.result.trim()}`
              : event.result.trim()
            lastAssistantMessage = event.result.trim()
          }
          const errorText = [
            ...(Array.isArray(event.errors) ? event.errors : []),
            typeof event.result === 'string' ? event.result : '',
          ]
            .find((value) => typeof value === 'string' && value.trim().length > 0)
          if (event.is_error || (typeof event.subtype === 'string' && event.subtype !== 'success')) {
            subagentStatus = 'errored'
            if (errorText) {
              subagentErrorMessage = errorText.trim()
            }
          }
        }
      }

      const finalized = finalizeSubagentOutputFromState({
        textOutput: resultText,
        toolCalls,
        lastAssistantMessage,
        errorMessage: subagentErrorMessage,
        status: subagentStatus,
      })

      // Fire SubagentStop hook on the parent's hook registry
      if (context.hookRegistry) {
        const hookResult = await context.hookRegistry.executeDetailed('SubagentStop', {
          event: 'SubagentStop',
          agent_id: agentId,
          agent_type: agentType,
          agent_transcript_path: '',
          stop_hook_active: false,
          last_assistant_message: finalized.lastAssistantMessage || lastAssistantMessage.slice(0, 500) || undefined,
          sessionId: context.sessionId,
        })
        for (const evt of hookResult.events) {
          context.emitEvent?.(evt)
        }
      }

      return finalized.output
    }

    const prepareWorktree = () => {
      if (input.isolation !== 'worktree') return
      worktree = createManagedWorktree({ cwd: effectiveCwd })
      effectiveCwd = worktree.path
    }

    const runManagedSubagent = async () => {
      prepareWorktree()
      const output = await runSubagent()
      if (worktree && subagentStatus === 'completed') {
        removeManagedWorktree(worktree.id)
      }
      return output
    }

    try {
      if (input.run_in_background) {
        const controller = new AbortController()
        activeAbortSignal = controller.signal
        const parentAbortHandler = () => controller.abort()
        context.abortSignal?.addEventListener('abort', parentAbortHandler, { once: true })
        backgroundTask = createProcessJobRecord({
          subject: input.description,
          description: input.prompt,
          status: 'running',
          taskType: 'agent',
          metadata: { agentId, ...(worktree ? { worktree } : {}) },
          stop: () => controller.abort(),
        })
        context.emitEvent?.({
          type: 'system',
          subtype: 'task_started',
          task_id: backgroundTask.id,
          description: backgroundTask.subject,
          task_type: 'agent',
          prompt: input.prompt,
          session_id: context.sessionId || '',
        })

        void runManagedSubagent()
          .then(async (output) => {
            const status = subagentStatus === 'completed' ? 'completed' : subagentStatus === 'aborted' ? 'stopped' : 'failed'
            updateProcessJob(backgroundTask!.id, {
              status,
              output,
              metadata: { agentId, ...(worktree ? { worktree, retained: status !== 'completed' } : {}) },
            })
            unregisterProcessStopHandler(backgroundTask!.id)
            context.abortSignal?.removeEventListener('abort', parentAbortHandler)
            await context.onSubagentEnd?.({
              runId: agentId,
              status: subagentStatus,
              output,
              error: subagentStatus === 'errored' ? subagentErrorMessage : undefined,
            })
            context.emitEvent?.({
              type: 'system',
              subtype: 'task_notification',
              task_id: backgroundTask!.id,
              status: subagentStatus === 'completed' ? 'completed' : subagentStatus,
              summary: backgroundTask!.subject,
              session_id: context.sessionId || '',
            })
            context.onBackgroundTaskCompleted?.()
          })
          .catch(async (err: any) => {
            updateProcessJob(backgroundTask!.id, {
              status: 'failed',
              output: `Subagent error: ${err.message}`,
              metadata: { agentId, ...(worktree ? { worktree, retained: true } : {}) },
            })
            unregisterProcessStopHandler(backgroundTask!.id)
            context.abortSignal?.removeEventListener('abort', parentAbortHandler)
            await context.onSubagentEnd?.({ runId: agentId, status: 'errored', error: err.message })
            context.emitEvent?.({
              type: 'system',
              subtype: 'task_notification',
              task_id: backgroundTask!.id,
              status: 'failed',
              summary: err.message,
              session_id: context.sessionId || '',
            })
            context.onBackgroundTaskCompleted?.()
          })

        return {
          type: 'tool_result',
          tool_use_id: '',
          content: `Background agent started: ${backgroundTask.id}\nUse ProcessOutput with task_id=${backgroundTask.id} to inspect progress.`,
          _meta: {
            task: { id: backgroundTask.id, kind: 'agent', agentId, status: 'running' },
            ...(worktree ? { worktree: { ...worktree, retained: true } } : {}),
          },
        }
      }

      const output = await runManagedSubagent()
      const finalStatus = subagentStatus as 'completed' | 'errored' | 'aborted'
      const errored = finalStatus === 'errored'
      const aborted = finalStatus === 'aborted'
      await context.onSubagentEnd?.({ runId: agentId, status: finalStatus, output, error: errored ? subagentErrorMessage : undefined })
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: output + (
          input.team_name || input.name || input.mode || input.isolation
            ? `\n[agent meta: ${[
                input.name ? `name=${input.name}` : null,
                input.team_name ? `team=${input.team_name}` : null,
                input.mode ? `mode=${input.mode}` : null,
                input.isolation ? `isolation=${input.isolation}` : null,
              ].filter(Boolean).join(', ')}]`
            : ''
        ),
        ...(errored || aborted ? { is_error: true } : {}),
        ...(worktree ? { _meta: { worktree: { ...worktree, retained: false } } } : {}),
      }
    } catch (err: any) {
      await context.onSubagentEnd?.({ runId: agentId, status: 'errored', error: err.message })
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: `Subagent error: ${err.message}`,
        is_error: true,
        ...(worktree ? { _meta: { worktree: { ...worktree, retained: true } } } : {}),
      }
    }
  },
}
