/**
 * Tool interface and helper utilities
 */

import type { ToolDefinition, ToolInputSchema, ToolContext, ToolResult } from '../types.js'

/**
 * Helper to create a tool definition with sensible defaults.
 */
export function defineTool(config: {
  name: string
  description: string
  inputSchema: ToolInputSchema
  call: (input: any, context: ToolContext) => Promise<
    | string
    | ToolResult
    | { data: unknown; is_error?: boolean; _meta?: Record<string, unknown> }
  >
  isReadOnly?: boolean
  isConcurrencySafe?: boolean
  prompt?: string | ((context: ToolContext) => Promise<string>)
}): ToolDefinition {
  return {
    name: config.name,
    description: config.description,
    inputSchema: config.inputSchema,
    isReadOnly: () => config.isReadOnly ?? false,
    isConcurrencySafe: () => config.isConcurrencySafe ?? false,
    isEnabled: () => true,
    prompt: typeof config.prompt === 'function'
      ? config.prompt
      : async (_context: ToolContext) => (config.prompt as string) ?? config.description,
    async call(input: any, context: ToolContext): Promise<ToolResult> {
      try {
        const result = await config.call(input, context)
        return normalizeToolCallResult(result)
      } catch (err: any) {
        return {
          type: 'tool_result',
          tool_use_id: '',
          content: `Error: ${err.message}`,
          is_error: true,
        }
      }
    },
  }
}

function normalizeToolCallResult(
  result: string | ToolResult | { data: unknown; is_error?: boolean; _meta?: Record<string, unknown> },
): ToolResult {
  if (isToolResult(result)) return result

  if (typeof result === 'string') {
    return {
      type: 'tool_result',
      tool_use_id: '',
      content: result,
      is_error: false,
    }
  }

  const payload = result.data
  if (isRecord(payload) && 'content' in payload) {
    return {
      type: 'tool_result',
      tool_use_id: '',
      content: typeof payload.content === 'string' || Array.isArray(payload.content)
        ? payload.content as ToolResult['content']
        : JSON.stringify(payload.content, null, 2),
      ...(result.is_error ? { is_error: true } : {}),
      ...(isRecord(payload._meta) ? { _meta: payload._meta } : {}),
      ...(result._meta ? { _meta: result._meta } : {}),
    }
  }

  return {
    type: 'tool_result',
    tool_use_id: '',
    content: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2),
    is_error: result.is_error || false,
    ...(result._meta ? { _meta: result._meta } : {}),
  }
}

function isToolResult(value: unknown): value is ToolResult {
  return isRecord(value)
    && value.type === 'tool_result'
    && typeof value.tool_use_id === 'string'
    && 'content' in value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Convert a ToolDefinition to API-compatible tool format.
 * Returns the normalized tool format used by providers.
 */
export function toApiTool(tool: ToolDefinition): {
  name: string
  description: string
  input_schema: ToolInputSchema
} {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }
}
