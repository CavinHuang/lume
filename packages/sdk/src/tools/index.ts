/**
 * Tool Registry - All built-in tool definitions
 *
 * Tools covering file I/O, execution, search, web, agents,
 * tasks, worktree, planning, scheduling, and more.
 */

import type { ToolDefinition } from '../types.js'
import { matchesAnyToolPattern } from '../utils/tool-approval.js'
import { createToolRegistry } from './registry.js'

// File I/O
import { BashTool } from './bash.js'
import { FileReadTool } from './read.js'
import { FileWriteTool } from './write.js'
import { FileEditTool } from './edit.js'
import { GlobTool } from './glob.js'
import { GrepTool } from './grep.js'
import { NotebookEditTool } from './notebook-edit.js'

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

// Persistent Tasks are host-bound through createTaskTools and are not part of
// the SDK's unscoped base tool pool.

// Worktree
import { EnterWorktreeTool, ExitWorktreeTool } from './worktree-tools.js'

// User interaction
import { AskUserQuestionTool } from './ask-user.js'

// Discovery
import { ToolSearchTool } from './tool-search.js'

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
  GlobTool,
  GrepTool,
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

  // Internal process controls are intentionally not model-visible.

  // Worktree
  EnterWorktreeTool,
  ExitWorktreeTool,

  // User interaction
  AskUserQuestionTool,

  // Discovery
  ToolSearchTool,

  // Skill
  SkillTool,
]

/** Schemas always sent to the provider when deferred tool loading is enabled. */
export const CORE_TOOL_NAMES = new Set([
  'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'NotebookEdit',
  'WebFetch', 'WebSearch', 'Agent', 'AskUserQuestion', 'Skill',
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

// Re-export individual tools
export {
  // Core
  BashTool,
  FileReadTool,
  FileWriteTool,
  FileEditTool,
  GlobTool,
  GrepTool,
  NotebookEditTool,
  WebFetchTool,
  WebSearchTool,
  GuanlanSearchTool,
  GuanlanReadTool,
  GuanlanHotnewsTool,
  GuanlanResearchTool,
  // Agent
  AgentTool,
  // Persistent Tasks are host-bound; see createTaskTools.
  // Worktree
  EnterWorktreeTool,
  ExitWorktreeTool,
  // User
  AskUserQuestionTool,
  // Discovery
  ToolSearchTool,
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
  const registry = createToolRegistry();
  registry.global.register(tools);
  registry.preset("default").setCore([...CORE_TOOL_NAMES]);
  return registry.agent("adapter").view().split();
}

// Re-export helpers
export { defineTool, toApiTool } from './types.js'
