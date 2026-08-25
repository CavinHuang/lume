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
  validateInput?: (input: any, context: ToolContext) => void | string | Promise<void | string>
  outputSchema?: Record<string, unknown>
  getPath?: (input: any, context: ToolContext) => string | undefined | Promise<string | undefined>
  // 函数形态会被 tool-source 的 readDeclaredReadOnly 无参求值以提取声明意图；
  // 依赖入参的实现必须容忍无参调用（返回 boolean 或抛错回退类别推断）
  isReadOnly?: boolean | ((input: any, context?: ToolContext) => boolean)
  isConcurrencySafe?: boolean | ((input: any, context?: ToolContext) => boolean)
  prompt?: string | ((context: ToolContext) => Promise<string>)
  /**
   * 工具自带的运行时元数据（注入池归属 requiredDuringSkillScope 等可由工具
   * 自声明）。审批豁免键 delegatesPermission 由宿主 wrapper 盖章写入，
   * defineTool 通道一律剥离——第三方不得经此跳过 canUseTool（#711 review）。
   */
  runtimeMetadata?: Record<string, unknown>
}): ToolDefinition {
  const { delegatesPermission: _strippedDelegatesPermission, ...declaredRuntimeMetadata } = config.runtimeMetadata ?? {}
  return {
    name: config.name,
    description: config.description,
    inputSchema: config.inputSchema,
    ...(config.runtimeMetadata ? { runtimeMetadata: declaredRuntimeMetadata } : {}),
    ...(config.validateInput ? { validateInput: config.validateInput } : {}),
    ...(config.outputSchema ? { outputSchema: config.outputSchema } : {}),
    ...(config.getPath ? { getPath: config.getPath } : {}),
    isReadOnly: (input?: unknown, context?: ToolContext) => typeof config.isReadOnly === 'function'
      ? config.isReadOnly(input, context)
      : config.isReadOnly ?? false,
    isConcurrencySafe: (input?: unknown, context?: ToolContext) => typeof config.isConcurrencySafe === 'function'
      ? config.isConcurrencySafe(input, context)
      : config.isConcurrencySafe ?? false,
    isEnabled: () => true,
    prompt: typeof config.prompt === 'function'
      ? config.prompt
      : async (_context: ToolContext) => (config.prompt as string) ?? config.description,
    async call(input: any, context: ToolContext): Promise<ToolResult> {
      try {
        const validationError = await config.validateInput?.(input, context)
        if (typeof validationError === 'string' && validationError.trim()) {
          return {
            type: 'tool_result',
            tool_use_id: '',
            content: `Invalid input for tool "${config.name}": ${validationError}`,
            is_error: true,
          }
        }
        const result = await config.call(input, context)
        return normalizeToolCallResult(result)
      } catch (err: any) {
        return {
          type: 'tool_result',
          tool_use_id: '',
          content: formatToolError(err, config.name),
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

/** Keep provider-facing failures actionable without leaking a stack trace. */
export function formatToolError(error: unknown, toolName?: string): string {
  if (error instanceof Error) {
    const record = error as Error & { code?: unknown; cause?: unknown }
    const name = record.name && record.name !== 'Error' ? `${record.name}: ` : ''
    const code = typeof record.code === 'string' ? ` [${record.code}]` : ''
    const prefix = toolName ? `Error in ${toolName}` : 'Error'
    const cause = record.cause instanceof Error ? ` Cause: ${record.cause.message}` : ''
    return `${prefix}${code}: ${name}${record.message || 'Unknown error'}${cause}`
  }
  return `${toolName ? `Error in ${toolName}` : 'Error'}: ${String(error)}`
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
