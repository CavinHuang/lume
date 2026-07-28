/**
 * Tool Registry - All built-in tool definitions
 *
 * 30+ tools covering file I/O, execution, search, web, agents,
 * tasks, teams, messaging, worktree, planning, scheduling, and more.
 */

import type { ToolDefinition } from '../types.js'
import { matchesAnyToolPattern } from '../utils/tool-approval.js'

// File I/O
import { BashTool } from './bash.js'
import { FileReadTool } from './read.js'
import { FileWriteTool } from './write.js'
import { FileEditTool } from './edit.js'
import { FindFilesTool } from './find-files.js'
import { GlobTool } from './glob.js'
import { GrepTool } from './grep.js'
import { NotebookEditTool } from './notebook-edit.js'
import { ListWorkspaceTreeTool } from './workspace-tree.js'

// Web
import { WebFetchTool } from './web-fetch.js'
import { WebSearchTool } from './web-search.js'
import {
  GuanlanHotnewsTool,
  GuanlanReadTool,
  GuanlanResearchTool,
  GuanlanSearchTool,
} from './guanlan.js'

// Agent & Multi-agent
import { AgentTool } from './agent-tool.js'
import { SendMessageTool } from './send-message.js'
import { TeamCreateTool, TeamDeleteTool } from './team-tools.js'

// Persistent Tasks are host-bound through createTaskTools and are not part of
// the SDK's unscoped base tool pool.

// Worktree
import { EnterWorktreeTool, ExitWorktreeTool } from './worktree-tools.js'

// User interaction
import { AskUserQuestionTool } from './ask-user.js'

// Discovery
import { ToolSearchTool } from './tool-search.js'

// MCP Resources
import {
  ListMcpResourcesTool,
  ReadMcpResourceTool,
  SubscribeMcpResourceTool,
  UnsubscribeMcpResourceTool,
  SubscribePollingTool,
  UnsubscribePollingTool,
  McpAuthTool,
} from './mcp-resource-tools.js'

// LSP
import { LSPApplyTool, LSPTool } from './lsp-tool.js'

// Config
import { ConfigTool } from './config-tool.js'

// Todo
import { createTodoTool } from './todo-tool.js'

// Skill
import { SkillTool, createSkillTool } from './skill-tool.js'

/**
 * All built-in tools (30+).
 */
const ALL_TOOLS: ToolDefinition[] = [
  // Core file I/O & execution
  BashTool,
  FileReadTool,
  FileWriteTool,
  FileEditTool,
  FindFilesTool,
  GlobTool,
  GrepTool,
  ListWorkspaceTreeTool,
  NotebookEditTool,

  // Web
  WebFetchTool,
  WebSearchTool,
  GuanlanSearchTool,
  GuanlanReadTool,
  GuanlanHotnewsTool,
  GuanlanResearchTool,

  // Agent & Multi-agent
  AgentTool,
  SendMessageTool,
  TeamCreateTool,
  TeamDeleteTool,

  // Internal process controls are intentionally not model-visible.

  // Worktree
  EnterWorktreeTool,
  ExitWorktreeTool,

  // User interaction
  AskUserQuestionTool,

  // Discovery
  ToolSearchTool,

  // MCP Resources
  ListMcpResourcesTool,
  ReadMcpResourceTool,
  SubscribeMcpResourceTool,
  UnsubscribeMcpResourceTool,
  SubscribePollingTool,
  UnsubscribePollingTool,
  McpAuthTool,

  // LSP
  LSPTool,
  LSPApplyTool,

  // Config
  ConfigTool,

  // Skill
  SkillTool,
]

/** Schemas always sent to the provider when deferred tool loading is enabled. */
export const CORE_TOOL_NAMES = new Set([
  'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'NotebookEdit',
  'WebFetch', 'WebSearch', 'Agent', 'AskUserQuestion', 'Skill', 'LSP', 'LSPApply',
  'ProcessOutput', 'ProcessStop', 'TaskOutput', 'TaskStop', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate',
])

/**
 * Get all built-in tools.
 */
export function getAllBaseTools(): ToolDefinition[] {
  return [...ALL_TOOLS]
}

/**
 * Filter tools by allowed/disallowed lists.
 */
export function filterTools(
  tools: ToolDefinition[],
  allowedTools?: string[],
  disallowedTools?: string[],
): ToolDefinition[] {
  let filtered = tools

  if (allowedTools && allowedTools.length > 0) {
    filtered = filtered.filter((tool) => matchesAnyToolPattern(tool.name, allowedTools))
  }

  if (disallowedTools && disallowedTools.length > 0) {
    filtered = filtered.filter((tool) => !matchesAnyToolPattern(tool.name, disallowedTools))
  }

  return filtered
}

/**
 * Filter tools using only disallow rules.
 *
 * Official Claude Agent SDK semantics treat allowedTools as permission
 * pre-approval, not tool visibility. This helper keeps visibility changes
 * limited to explicit deny rules.
 */
export function filterDisallowedTools(
  tools: ToolDefinition[],
  disallowedTools?: string[],
): ToolDefinition[] {
  if (!disallowedTools || disallowedTools.length === 0) {
    return tools
  }

  return tools.filter((tool) => !matchesAnyToolPattern(tool.name, disallowedTools))
}

/**
 * Assemble tool pool: base tools + MCP tools, with deduplication.
 */
export function assembleToolPool(
  baseTools: ToolDefinition[],
  mcpTools: ToolDefinition[] = [],
  _allowedTools?: string[],
  disallowedTools?: string[],
): ToolDefinition[] {
  const combined = [...baseTools, ...mcpTools]

  // Deduplicate by name (later definitions override)
  const byName = new Map<string, ToolDefinition>()
  for (const tool of combined) {
    byName.set(tool.name, tool)
  }

  let tools = Array.from(byName.values())
  return filterDisallowedTools(tools, disallowedTools)
}

// Re-export individual tools
export {
  // Core
  BashTool,
  FileReadTool,
  FileWriteTool,
  FileEditTool,
  FindFilesTool,
  GlobTool,
  GrepTool,
  ListWorkspaceTreeTool,
  NotebookEditTool,
  WebFetchTool,
  WebSearchTool,
  GuanlanSearchTool,
  GuanlanReadTool,
  GuanlanHotnewsTool,
  GuanlanResearchTool,
  // Agent
  AgentTool,
  SendMessageTool,
  TeamCreateTool,
  TeamDeleteTool,
  // Persistent Tasks are host-bound; see createTaskTools.
  // Worktree
  EnterWorktreeTool,
  ExitWorktreeTool,
  // User
  AskUserQuestionTool,
  // Discovery
  ToolSearchTool,
  // MCP
  ListMcpResourcesTool,
  ReadMcpResourceTool,
  SubscribeMcpResourceTool,
  UnsubscribeMcpResourceTool,
  SubscribePollingTool,
  UnsubscribePollingTool,
  McpAuthTool,
  // LSP
  LSPTool,
  LSPApplyTool,
  // Config
  ConfigTool,
  // Todo
  createTodoTool,
  // Skill
  SkillTool,
  createSkillTool,
}

export function splitDeferredTools(tools: ToolDefinition[]): {
  core: ToolDefinition[]
  deferred: ToolDefinition[]
} {
  const candidates = tools.filter((tool) => tool.name !== 'ToolSearch' && tool.name !== 'ExecuteTool')
  return {
    core: candidates.filter((tool) =>
      CORE_TOOL_NAMES.has(tool.name)
      || tool.runtimeMetadata?.requiredDuringSkillScope === true
    ),
    deferred: candidates.filter((tool) =>
      !CORE_TOOL_NAMES.has(tool.name)
      && tool.runtimeMetadata?.requiredDuringSkillScope !== true
    ),
  }
}

export type { LspWorkspaceEditPreview } from './lsp-tool.js'

// Re-export helpers
export { defineTool, toApiTool } from './types.js'
