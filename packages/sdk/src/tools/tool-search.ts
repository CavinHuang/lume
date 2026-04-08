/**
 * ToolSearchTool - Discover deferred/lazy-loaded tools
 *
 * Allows the model to search for tools that haven't been loaded yet.
 * Supports keyword search and exact name selection.
 */

import type { ToolDefinition, ToolResult } from '../types.js'
import { estimateTokens, getContextWindowSize } from '../utils/tokens.js'

// Registry of deferred tools (set by the agent)
let deferredTools: ToolDefinition[] = []

export type ToolSearchMode = 'standard' | 'tst' | 'tst-auto'

/**
 * Set deferred tools available for search.
 */
export function setDeferredTools(tools: ToolDefinition[]): void {
  deferredTools = tools
}

export function getDeferredTools(): ToolDefinition[] {
  return [...deferredTools]
}

export function getToolSearchMode(): ToolSearchMode {
  const value = (process.env.ENABLE_TOOL_SEARCH || '').trim().toLowerCase()
  if (!value) return 'tst'
  if (value === 'false' || value === '0' || value === 'off') return 'standard'
  if (value === 'auto' || value.startsWith('auto:')) return 'tst-auto'
  return 'tst'
}

function getAutoToolSearchPercentage(): number {
  const value = (process.env.ENABLE_TOOL_SEARCH || '').trim().toLowerCase()
  if (!value.startsWith('auto:')) return 10
  const parsed = Number.parseInt(value.slice(5), 10)
  if (Number.isNaN(parsed)) return 10
  return Math.max(0, Math.min(100, parsed))
}

export function getDeferredToolTokenCount(tools: ToolDefinition[]): number {
  return tools.reduce(
    (total, tool) =>
      total +
      estimateTokens(tool.name) +
      estimateTokens(tool.description) +
      estimateTokens(JSON.stringify(tool.inputSchema)),
    0,
  )
}

export function shouldEnableAutomaticToolSearch(
  tools: ToolDefinition[],
  model: string,
): boolean {
  if (tools.length === 0) return false
  const threshold = Math.floor(
    getContextWindowSize(model) * (getAutoToolSearchPercentage() / 100),
  )
  return getDeferredToolTokenCount(tools) >= threshold
}

export function isToolSearchEnabled(
  tools: ToolDefinition[],
  model: string,
): boolean {
  const mode = getToolSearchMode()
  if (mode === 'standard') return false
  if (mode === 'tst') return true
  return shouldEnableAutomaticToolSearch(tools, model)
}

export const ToolSearchTool: ToolDefinition = {
  name: 'ToolSearch',
  description: 'Search for additional tools that may be available but not yet loaded. Use keyword search or exact name selection.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query. Use "select:ToolName" for exact match or keywords for search.',
      },
      max_results: {
        type: 'number',
        description: 'Maximum results to return (default: 5)',
      },
    },
    required: ['query'],
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
  async prompt() { return 'Search for available tools.' },
  async call(input: any): Promise<ToolResult> {
    const { query, max_results = 5 } = input

    if (deferredTools.length === 0) {
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: 'No deferred tools available.',
      }
    }

    let matches: ToolDefinition[]
    const normalizedQuery = String(query).trim()

    if (normalizedQuery.startsWith('select:')) {
      // Exact name selection
      const names = normalizedQuery.slice(7).split(',').map((n: string) => n.trim())
      matches = deferredTools.filter(t => names.includes(t.name))
    } else {
      // Keyword search
      const keywords: string[] = normalizedQuery.toLowerCase().split(/\s+/)
      matches = deferredTools
        .map((tool) => {
          const searchText = `${tool.name} ${tool.description}`.toLowerCase()
          let score = 0
          for (const keyword of keywords) {
            if (tool.name.toLowerCase() === keyword) score += 5
            else if (tool.name.toLowerCase().includes(keyword)) score += 3
            else if (searchText.includes(keyword)) score += 1
          }
          return { tool, score }
        })
        .filter((entry) => entry.score > 0)
        .sort((left, right) => right.score - left.score || left.tool.name.localeCompare(right.tool.name))
        .slice(0, max_results)
        .map((entry) => entry.tool)
    }

    if (matches.length === 0) {
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: `No tools found matching "${normalizedQuery}"`,
      }
    }

    const lines = matches.map((tool) =>
      `- ${tool.name}: ${tool.description.slice(0, 200)}`
    )

    return {
      type: 'tool_result',
      tool_use_id: '',
      content: `Found ${matches.length} deferred tool(s). Use select:<ToolName> to request an exact tool.\n${lines.join('\n')}`,
    }
  },
}
