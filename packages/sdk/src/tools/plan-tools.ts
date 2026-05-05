/**
 * Plan Mode Tools
 *
 * EnterPlanMode / ExitPlanMode - Structured planning workflow.
 * Allows the agent to enter a design/planning phase before execution.
 */

import type { ToolDefinition, ToolResult } from '../types.js'

// Track plan mode state
let planModeActive = false
let currentTaskContract: string | null = null

export function isPlanModeActive(): boolean {
  return planModeActive
}

export function getCurrentTaskContract(): string | null {
  return currentTaskContract
}

export const EnterPlanModeTool: ToolDefinition = {
  name: 'EnterPlanMode',
  description: 'Enter plan mode for complex tasks so the agent can explore and design before coding.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
  async prompt() { return 'Enter plan mode to produce an approvable task contract before execution.' },
  async call(): Promise<ToolResult> {
    if (planModeActive) {
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: 'Already in plan mode.',
      }
    }

    planModeActive = true
    currentTaskContract = null

    return {
      type: 'tool_result',
      tool_use_id: '',
      content: 'Entered plan mode. Focus on exploration and implementation design only. Do not start editing files in plan mode. When the task contract is ready, call TaskContractWrite with status "needs_approval" so the user can review the task list before automatic execution.',
    }
  },
}

export const ExitPlanModeTool: ToolDefinition = {
  name: 'ExitPlanMode',
  description: 'Exit plan mode after publishing an approvable task contract.',
  inputSchema: {
    type: 'object',
    properties: {
      taskContract: { type: 'string', description: 'The completed task contract' },
      approved: { type: 'boolean', description: 'Whether the task contract is approved for execution' },
      allowedPrompts: {
        type: 'array',
        description: 'Optional semantic permissions required to implement the task contract',
        items: {
          type: 'object',
          properties: {
            tool: { type: 'string' },
            prompt: { type: 'string' },
          },
          required: ['tool', 'prompt'],
        },
      },
    },
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
  async prompt() { return 'Exit plan mode after publishing a completed task contract.' },
  async call(input: any): Promise<ToolResult> {
    if (!planModeActive) {
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: 'Not in plan mode.',
        is_error: true,
      }
    }

    planModeActive = false
    currentTaskContract = input.taskContract || currentTaskContract

    const status = input.approved !== false ? 'approved' : 'pending approval'
    const allowedPrompts = Array.isArray(input.allowedPrompts) && input.allowedPrompts.length > 0
      ? `\n\nAllowed prompts:\n${input.allowedPrompts.map((prompt: any) => `- ${prompt.tool}: ${prompt.prompt}`).join('\n')}`
      : ''

    return {
      type: 'tool_result',
      tool_use_id: '',
      content: `User has approved exiting plan mode. You can now start coding. Task contract status: ${status}.${currentTaskContract ? `\n\nApproved task contract:\n${currentTaskContract}` : ''}${allowedPrompts}`,
    }
  },
}
