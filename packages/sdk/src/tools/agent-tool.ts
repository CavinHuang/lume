/**
 * AgentTool shell — spawn subagents for parallel/delegated work.
 *
 * The SDK ships the contract only (name/description/schema/validation).
 * The host runtime spreads this shell and supplies its own `call`, so the
 * shape below is load-bearing: keep every field the spread consumers rely on.
 */

import type { ToolDefinition } from '../types.js'

export const AgentTool: ToolDefinition = {
  name: 'Agent',
  description: 'Launch a new agent to handle a complex, multi-step task. Each agent runs in its own context with its own tool set; the call blocks until the subagent finishes and returns its final output. Creating an independent task requires new_task=true; to continue an existing task pass task_id instead (never copy a raw user message as the prompt).',
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
      mode: {
        type: 'string',
        enum: ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'],
        description: 'Permission mode for the spawned agent',
      },
      run_in_background: {
        type: 'boolean',
        description: 'Run the subagent in the background and return a task ID immediately',
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
    if (input.run_in_background !== undefined && typeof input.run_in_background !== 'boolean') return 'run_in_background must be a boolean.'
  },
  async prompt() {
    return 'Launch a subagent to handle complex tasks autonomously.'
  },
  async call() {
    // The host runtime replaces this call when spreading the shell
    // ({ ...AgentTool, call }); the SDK core runs no nested agent engine.
    throw new Error('AgentTool.call is implemented by the host runtime.')
  },
}
