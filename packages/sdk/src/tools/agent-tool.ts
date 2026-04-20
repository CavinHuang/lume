/**
 * AgentTool - Spawn subagents for parallel/delegated work
 *
 * Supports built-in agents (Explore, Plan) and custom agent definitions.
 * Agents run as nested query loops with their own context and tool sets.
 */

import type { ToolDefinition, ToolContext, ToolResult, AgentDefinition, SDKMessage } from '../types.js'
import { QueryEngine } from '../engine.js'
import { createProvider, type ApiType } from '../providers/index.js'
import { createTaskRecord, updateTaskRecord } from './task-tools.js'
import { loadSession } from '../session.js'
import { finalizeSubagentOutputFromState, summarizeSubagentAssistantEvent } from './subagent-output.js'
import { annotateSubagentStreamingEvent } from './agent-tool-events.js'

// Store for registered agent definitions
let registeredAgents: Record<string, AgentDefinition> = {}

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
  description: 'Launch a new agent to handle complex, multi-step tasks. Each agent has its own context and tool set. IMPORTANT: When tasks are independent, produce MULTIPLE Agent tool_use calls in a single response — they will execute in parallel automatically. Do not use run_in_background.',
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
      isolation: {
        type: 'string',
        enum: ['remote', 'worktree'],
        description: 'Isolation mode. remote is treated as a background subagent alias in this SDK.',
      },
      cwd: {
        type: 'string',
        description: 'Optional working directory override for the spawned agent',
      },
      run_in_background: {
        type: 'boolean',
        description: 'Whether to run in background',
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
  async prompt() {
    return 'Launch a subagent to handle complex tasks autonomously.'
  },
  async call(input: any, context: ToolContext): Promise<ToolResult> {
    const { getAllBaseTools, filterTools } = await import('./index.js')
    const agentType = input.subagent_type || 'general-purpose'
    const effectiveCwd = input.cwd || context.cwd

    // Find agent definition
    const agentDef = registeredAgents[agentType] || BUILTIN_AGENTS[agentType]

    // Determine tools for subagent
    let tools = getAllBaseTools()
    if (agentDef?.tools) {
      tools = filterTools(tools, agentDef.tools)
    }

    // Remove AgentTool from subagent to prevent infinite recursion
    tools = tools.filter(t => t.name !== 'Agent')

    // Build system prompt
    const systemPrompt = agentDef?.prompt ||
      'You are a helpful assistant. Complete the given task using the available tools.'

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

    const runSubagent = async (
      progress?: {
        taskId: string
        description: string
      },
    ) => {
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

      const startedAt = Date.now()
      let toolUseCount = 0
      const engine = new QueryEngine({
        cwd: effectiveCwd,
        model: subModel,
        provider,
        tools,
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
        sessionId: context.sessionId,
        permissionMode: input.mode,
        abortSignal: context.abortSignal,
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
        if (context.abortSignal?.aborted) {
          subagentStatus = 'aborted'
          break
        }
        const taggedEvent = annotateSubagentStreamingEvent(event as SDKMessage, {
          subagentRunId: agentId,
          parentSessionId: context.sessionId,
        })
        if (taggedEvent) {
          context.emitEvent?.(taggedEvent)
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
          toolUseCount += summary.toolUseCount
          if (progress) {
            context.emitEvent?.({
              type: 'system',
              subtype: 'task_progress',
              task_id: progress.taskId,
              description: progress.description,
              last_tool_name: toolCalls.at(-1),
              usage: {
                total_tokens: 0,
                tool_uses: toolUseCount,
                duration_ms: Date.now() - startedAt,
              },
              summary: resultText.slice(0, 200) || undefined,
              session_id: context.sessionId || '',
              subagent_run_id: agentId,
            } as any)
          }
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

    if (input.run_in_background || input.isolation === 'remote') {
      const task = createTaskRecord({
        subject: input.description || 'Background subagent',
        description: input.prompt,
        status: 'running',
        taskType: 'subagent',
        metadata: {
          agentType,
          team_name: input.team_name,
          mode: input.mode,
          isolation: input.isolation,
          cwd: effectiveCwd,
          name: input.name,
        },
      })

      context.emitEvent?.({
        type: 'system',
        subtype: 'task_started',
        task_id: task.id,
        description: task.subject,
        task_type: 'subagent',
        prompt: input.prompt,
        session_id: context.sessionId || '',
        subagent_run_id: agentId,
      } as any)

      void runSubagent({
        taskId: task.id,
        description: task.subject,
      })
        .then(async (output) => {
          updateTaskRecord(task.id, { status: 'completed', output })
          await context.onSubagentEnd?.({ runId: agentId, status: 'completed', output })
          context.emitEvent?.({
            type: 'system',
            subtype: 'task_progress',
            task_id: task.id,
            description: task.subject,
            last_tool_name: 'Agent',
            usage: {
              total_tokens: 0,
              tool_uses: 1,
              duration_ms: 0,
            },
            summary: 'Subagent completed',
            session_id: context.sessionId || '',
          })
          context.emitEvent?.({
            type: 'system',
            subtype: 'task_notification',
            task_id: task.id,
            status: 'completed',
            summary: task.subject,
            output_file: task.outputFile || '',
            session_id: context.sessionId || '',
            subagent_run_id: agentId,
          })
        })
        .catch(async (err: any) => {
          updateTaskRecord(task.id, {
            status: 'failed',
            output: `Subagent error: ${err.message}`,
          })
          await context.onSubagentEnd?.({ runId: agentId, status: 'errored', error: err.message })
          context.emitEvent?.({
            type: 'system',
            subtype: 'task_progress',
            task_id: task.id,
            description: task.subject,
            last_tool_name: 'Agent',
            usage: {
              total_tokens: 0,
              tool_uses: 1,
              duration_ms: 0,
            },
            summary: 'Subagent failed',
            session_id: context.sessionId || '',
          })
          context.emitEvent?.({
            type: 'system',
            subtype: 'task_notification',
            task_id: task.id,
            status: 'failed',
            summary: task.subject,
            output_file: task.outputFile || '',
            session_id: context.sessionId || '',
            subagent_run_id: agentId,
          })
        })

      return {
        type: 'tool_result',
        tool_use_id: '',
        content: `Background subagent started: ${task.id}\nUse TaskOutput to inspect the result.`,
      }
    }

    try {
      if (input.isolation === 'worktree') {
        return {
          type: 'tool_result',
          tool_use_id: '',
          content: 'Error: worktree isolation is intentionally not handled in this alignment scope.',
          is_error: true,
        }
      }
      const output = await runSubagent()
      const errored = (subagentStatus as string) === 'errored'
      await context.onSubagentEnd?.({ runId: agentId, status: errored ? 'errored' : 'completed', output, error: errored ? subagentErrorMessage : undefined })
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
        ...(errored ? { is_error: true } : {}),
      }
    } catch (err: any) {
      await context.onSubagentEnd?.({ runId: agentId, status: 'errored', error: err.message })
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: `Subagent error: ${err.message}`,
        is_error: true,
      }
    }
  },
}
