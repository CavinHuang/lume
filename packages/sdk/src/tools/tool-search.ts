/** Discover and invoke tools whose schemas are intentionally deferred. */

import type { ToolDefinition, ToolResult } from '../types.js'
import { estimateTokens, getContextWindowSize } from '../utils/tokens.js'

let legacyDeferredTools: ToolDefinition[] = []

export type ToolSearchMode = 'standard' | 'tst' | 'tst-auto'

export function setDeferredTools(tools: ToolDefinition[]): void {
  legacyDeferredTools = tools
}

export function getDeferredTools(): ToolDefinition[] {
  return [...legacyDeferredTools]
}

export function getToolSearchMode(): ToolSearchMode {
  const value = (process.env.ENABLE_TOOL_SEARCH || '').trim().toLowerCase()
  if (!value) return 'tst'
  if (value === 'false' || value === '0' || value === 'off' || value === 'standard') return 'standard'
  if (value === 'auto' || value.startsWith('auto:')) return 'tst-auto'
  return 'tst'
}

function getAutoToolSearchPercentage(): number {
  const value = (process.env.ENABLE_TOOL_SEARCH || '').trim().toLowerCase()
  if (!value.startsWith('auto:')) return 10
  const parsed = Number.parseInt(value.slice(5), 10)
  return Number.isNaN(parsed) ? 10 : Math.max(0, Math.min(100, parsed))
}

/** 单工具 token 口径：name + description + inputSchema 全算（#389）。 */
export function estimateToolTokens(tool: ToolDefinition): number {
  return estimateTokens(tool.name) + estimateTokens(tool.description) + estimateTokens(JSON.stringify(tool.inputSchema))
}

export function getDeferredToolTokenCount(tools: ToolDefinition[]): number {
  return tools.reduce((total, tool) => total + estimateToolTokens(tool), 0)
}

export function shouldEnableAutomaticToolSearch(tools: ToolDefinition[], model: string): boolean {
  if (tools.length === 0) return false
  return getDeferredToolTokenCount(tools) >= Math.floor(getContextWindowSize(model) * (getAutoToolSearchPercentage() / 100))
}

export function isToolSearchEnabled(
  tools: ToolDefinition[],
  model: string,
  explicitMode?: ToolSearchMode,
): boolean {
  // 宿主显式模式优先于环境变量（#725 review S5）：测试/嵌入场景免 env 操控。
  const mode = explicitMode ?? getToolSearchMode()
  return mode === 'tst' || (mode === 'tst-auto' && shouldEnableAutomaticToolSearch(tools, model))
}

export function createToolSearchTool(getTools: () => ToolDefinition[]): ToolDefinition {
  return {
    name: 'ToolSearch',
    description: 'Discover additional tools whose full schemas are loaded only when needed. Search by capability or use select:ToolName.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords, or select:ToolName for an exact tool.' },
        max_results: { type: 'number', description: 'Maximum results to return (default 5).' },
      },
      required: ['query'],
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    isEnabled: () => true,
    runtimeMetadata: {
      source: 'sdk',
      category: 'read',
      capability: 'skill',
      riskLevel: 'low',
      sideEffects: 'none',
      allowedInPlanMode: true,
      isReadOnly: true,
      isConcurrencySafe: true,
      requiresApprovalByDefault: false,
    },
    async prompt() { return 'Search for available deferred tools.' },
    async call(input: any, context?: any): Promise<ToolResult> {
      const deferredTools = getTools()
      const query = typeof input?.query === 'string' ? input.query.trim() : ''
      const maxResults = Math.max(1, Math.min(Number(input?.max_results ?? 5), 20))
      if (!query) return failure('query is required.')
      if (deferredTools.length === 0) return success('No deferred tools available.')

      const matches = query.startsWith('select:')
        ? selectTools(deferredTools, query.slice(7))
        : searchTools(deferredTools, query, maxResults)
      if (matches.length === 0) return success(`No tools found matching "${query}".`)

      const matchedNames = matches.map((tool) => tool.name)
      const promoted = context?.activateTools?.(matchedNames)
      const usage = promoted && promoted.length > 0
        ? 'The matched tools are now available natively — call them directly by name with their documented parameters.'
        : 'Call ExecuteTool with tool_name and params to invoke a selected tool.'
      return success(JSON.stringify({
        tools: matches.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema })),
        usage,
      }, null, 2))
    },
  }
}

export function createExecuteTool(getTools: () => ToolDefinition[]): ToolDefinition {
  return {
    name: 'ExecuteTool',
    description: 'Invoke a tool returned by ToolSearch. The selected tool still receives its normal permission checks and hooks.',
    inputSchema: {
      type: 'object',
      properties: {
        tool_name: { type: 'string', description: 'Exact name returned by ToolSearch.' },
        params: { type: 'object', description: 'Parameters matching the selected tool input schema.' },
      },
      required: ['tool_name', 'params'],
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isEnabled: () => true,
    runtimeMetadata: {
      source: 'sdk',
      category: 'control',
      capability: 'skill',
      riskLevel: 'low',
      sideEffects: 'none',
      allowedInPlanMode: true,
      isReadOnly: false,
      isConcurrencySafe: false,
      requiresApprovalByDefault: false,
      delegatesPermission: true,
    },
    validateInput(input, context) {
      if (!input || typeof input !== 'object') return 'Input must be an object.'
      if (typeof input.tool_name !== 'string' || !input.tool_name.trim()) return 'tool_name is required.'
      if (!input.params || typeof input.params !== 'object' || Array.isArray(input.params)) return 'params must be an object.'
      // Promoted tools leave the deferred pool; the nested executor resolves them from the
      // native tools array, so only reject here when that bridge is unavailable.
      if (!getTools().some((tool) => tool.name === input.tool_name) && !context?.executeDeferredTool) return `Tool "${input.tool_name}" is not available through ToolSearch.`
    },
    async prompt() { return 'Invoke a deferred tool discovered through ToolSearch.' },
    async call(input, context) {
      if (!context.executeDeferredTool) return failure('Deferred tool execution is unavailable in this runtime.')
      return context.executeDeferredTool({ toolName: input.tool_name, params: input.params })
    },
  }
}

export const ToolSearchTool = createToolSearchTool(getDeferredTools)

function searchTools(tools: ToolDefinition[], query: string, maxResults: number): ToolDefinition[] {
  const keywords = query.toLowerCase().split(/\s+/).filter(Boolean)
  return tools.map((tool) => {
    const text = `${tool.name} ${tool.description}`.toLowerCase()
    const score = keywords.reduce((total, keyword) => total + (tool.name.toLowerCase() === keyword ? 5 : tool.name.toLowerCase().includes(keyword) ? 3 : text.includes(keyword) ? 1 : 0), 0)
    return { tool, score }
  }).filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.tool.name.localeCompare(right.tool.name))
    .slice(0, maxResults)
    .map((entry) => entry.tool)
}

function selectTools(tools: ToolDefinition[], selection: string): ToolDefinition[] {
  const names = new Set(selection.split(',').map((name) => name.trim()).filter(Boolean))
  return tools.filter((tool) => names.has(tool.name))
}

function success(content: string): ToolResult {
  return { type: 'tool_result', tool_use_id: '', content }
}

function failure(content: string): ToolResult {
  return { type: 'tool_result', tool_use_id: '', content, is_error: true }
}
