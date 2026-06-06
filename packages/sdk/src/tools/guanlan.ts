/**
 * Guanlan tools - Chinese internet search, page reading, hot news, and research.
 */

import { defineTool } from './types.js'
import {
  parseGuanlanSearchOutput,
  runGuanlanPython,
  truncateRawText,
  type SearchResult,
} from './web-search.js'

const GUANLAN_TOOL_TIMEOUT_MS = 120000
const GUANLAN_SEARCH_RESULT_CHARS = 30000
const GUANLAN_READ_RESULT_CHARS = 50000
const GUANLAN_RESEARCH_RESULT_CHARS = 50000

type GuanlanProfile = 'china' | 'global'

function withGuanlanRuntimeMetadata<T extends ReturnType<typeof defineTool>>(
  tool: T,
  maxResultChars: number,
  maxCallsPerTurn?: number
): T {
  tool.runtimeMetadata = {
    category: 'network',
    capability: 'web',
    riskLevel: 'low',
    sideEffects: 'network',
    allowedInPlanMode: true,
    isReadOnly: true,
    isConcurrencySafe: false,
    requiresNetwork: true,
    requiresApprovalByDefault: false,
    resultPolicy: { maxChars: maxResultChars },
    ...(maxCallsPerTurn ? { executionPolicy: { maxCallsPerTurn } } : {}),
  }
  return tool
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.max(min, Math.min(Math.trunc(numeric), max))
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function profileOrDefault(value: unknown): GuanlanProfile {
  return value === 'global' ? 'global' : 'china'
}

function requireGuanlanEnabled(): string | undefined {
  return process.env.LUME_GUANLAN_ENABLED === '1'
    ? undefined
    : 'Guanlan is disabled. Enable the Guanlan web search provider in settings before using this tool.'
}

function formatCommandError(command: string, stderr: string, stdout: string): string {
  return `${command} failed: ${truncateRawText(stderr || stdout || 'unknown error', 2000)}`
}

function formatSearchResults(results: SearchResult[], query: string): string {
  if (results.length === 0) return `No Guanlan results found for "${query}".`
  return [
    `Guanlan search results for "${query}":`,
    '',
    ...results.map((result, index) => {
      const parts = [`[${index + 1}] ${result.title}`, `URL: ${result.url}`]
      if (result.snippet) parts.push(result.snippet)
      return parts.join('\n')
    }),
  ].join('\n\n')
}

function commandResult(content: string, maxChars: number): { data: string } {
  return { data: truncateRawText(content.trim(), maxChars) }
}

export function buildGuanlanSearchArgs(input: Record<string, unknown>): string[] {
  const query = asNonEmptyString(input.query) ?? ''
  const args = [
    'search',
    query,
    '--profile',
    profileOrDefault(input.profile),
    '--limit',
    String(clampInt(input.max_results, 10, 1, 50)),
    '--json',
  ]
  const scope = asNonEmptyString(input.scope)
  if (scope) args.push('--scope', scope)
  const site = asNonEmptyString(input.site)
  if (site) args.push('--site', site)
  return args
}

export function buildGuanlanReadArgs(input: Record<string, unknown>): string[] {
  const args = [
    'read',
    asNonEmptyString(input.url) ?? '',
    '--max-chars',
    String(clampInt(input.max_chars, 12000, 1000, GUANLAN_READ_RESULT_CHARS)),
  ]
  if (input.strict === true) args.push('--strict')
  return args
}

export function buildGuanlanHotnewsArgs(input: Record<string, unknown>): string[] {
  const args = [
    'hotnews',
    asNonEmptyString(input.source) ?? 'today',
    '--limit',
    String(clampInt(input.limit, 20, 1, 50)),
  ]
  if (input.brief !== false) args.push('--brief')
  if (input.trends === true) args.push('--trends')
  return args
}

export function buildGuanlanResearchArgs(input: Record<string, unknown>): string[] {
  const args = [
    'research',
    asNonEmptyString(input.query) ?? '',
    '--profile',
    profileOrDefault(input.profile),
    '--read-top',
    String(clampInt(input.read_top, 2, 0, 5)),
    '--format',
    'markdown',
  ]
  const preset = asNonEmptyString(input.preset)
  if (preset) args.push('--preset', preset)
  return args
}

export const GuanlanSearchTool = withGuanlanRuntimeMetadata(defineTool({
  name: 'guanlan_search',
  description: '中文互联网搜索。基于观澜 Guanlan，聚合 Baidu/Bing/DDG 多后端并提供信源路由与分类。',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      profile: { type: 'string', enum: ['china', 'global'], description: 'Search profile, default china' },
      max_results: { type: 'number', minimum: 1, maximum: 50, description: 'Maximum results, default 10' },
      scope: { type: 'string', description: 'Optional Guanlan scope filter' },
      site: { type: 'string', description: 'Optional site/domain filter' },
    },
    required: ['query'],
  },
  isReadOnly: true,
  isConcurrencySafe: false,
  async call(input) {
    const disabled = requireGuanlanEnabled()
    if (disabled) return { data: disabled, is_error: true }

    const query = asNonEmptyString(input.query)
    if (!query) return { data: 'query is required', is_error: true }

    const result = await runGuanlanPython(buildGuanlanSearchArgs(input), GUANLAN_TOOL_TIMEOUT_MS)
    if (result.code !== 0) {
      return { data: formatCommandError('guanlan_search', result.stderr, result.stdout), is_error: true }
    }
    return commandResult(formatSearchResults(parseGuanlanSearchOutput(result.stdout), query), GUANLAN_SEARCH_RESULT_CHARS)
  },
}), GUANLAN_SEARCH_RESULT_CHARS, 8)

export const GuanlanReadTool = withGuanlanRuntimeMetadata(defineTool({
  name: 'guanlan_read',
  description: '读取中文网页。基于 Guanlan 的 Jina Reader 与直连 HTML 降级链，并进行中文网页质量检测。',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL to read' },
      max_chars: { type: 'number', minimum: 1000, maximum: GUANLAN_READ_RESULT_CHARS, description: 'Maximum characters, default 12000' },
      strict: { type: 'boolean', description: 'Use strict reading mode' },
    },
    required: ['url'],
  },
  isReadOnly: true,
  isConcurrencySafe: false,
  async call(input) {
    const disabled = requireGuanlanEnabled()
    if (disabled) return { data: disabled, is_error: true }

    const url = asNonEmptyString(input.url)
    if (!url || !/^https?:\/\//i.test(url)) return { data: 'url must be an http(s) URL', is_error: true }

    const result = await runGuanlanPython(buildGuanlanReadArgs(input), GUANLAN_TOOL_TIMEOUT_MS)
    if (result.code !== 0) {
      return { data: formatCommandError('guanlan_read', result.stderr, result.stdout), is_error: true }
    }
    return commandResult(result.stdout, GUANLAN_READ_RESULT_CHARS)
  },
}), GUANLAN_READ_RESULT_CHARS)

export const GuanlanHotnewsTool = withGuanlanRuntimeMetadata(defineTool({
  name: 'guanlan_hotnews',
  description: '中文热榜。基于 Guanlan 聚合百度、微博、B 站、IT 之家、V2EX 等多源热榜。',
  inputSchema: {
    type: 'object',
    properties: {
      source: { type: 'string', description: 'Hotnews source, default today' },
      limit: { type: 'number', minimum: 1, maximum: 50, description: 'Maximum items, default 20' },
      brief: { type: 'boolean', description: 'Return brief output, default true' },
      trends: { type: 'boolean', description: 'Include trend signals' },
    },
  },
  isReadOnly: true,
  isConcurrencySafe: false,
  async call(input) {
    const disabled = requireGuanlanEnabled()
    if (disabled) return { data: disabled, is_error: true }

    const result = await runGuanlanPython(buildGuanlanHotnewsArgs(input), GUANLAN_TOOL_TIMEOUT_MS)
    if (result.code !== 0) {
      return { data: formatCommandError('guanlan_hotnews', result.stderr, result.stdout), is_error: true }
    }
    return commandResult(result.stdout, GUANLAN_SEARCH_RESULT_CHARS)
  },
}), GUANLAN_SEARCH_RESULT_CHARS)

export const GuanlanResearchTool = withGuanlanRuntimeMetadata(defineTool({
  name: 'guanlan_research',
  description: '研究证据包。基于 Guanlan 自动路由信源、拆分查询，并进行多角色搜索。',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Research query' },
      profile: { type: 'string', enum: ['china', 'global'], description: 'Research profile, default china' },
      preset: { type: 'string', description: 'Optional Guanlan research preset' },
      read_top: { type: 'number', minimum: 0, maximum: 5, description: 'Number of top pages to read, default 2' },
    },
    required: ['query'],
  },
  isReadOnly: true,
  isConcurrencySafe: false,
  async call(input) {
    const disabled = requireGuanlanEnabled()
    if (disabled) return { data: disabled, is_error: true }

    const query = asNonEmptyString(input.query)
    if (!query) return { data: 'query is required', is_error: true }

    const result = await runGuanlanPython(buildGuanlanResearchArgs(input), GUANLAN_TOOL_TIMEOUT_MS)
    if (result.code !== 0) {
      return { data: formatCommandError('guanlan_research', result.stderr, result.stdout), is_error: true }
    }
    return commandResult(result.stdout, GUANLAN_RESEARCH_RESULT_CHARS)
  },
}), GUANLAN_RESEARCH_RESULT_CHARS)
