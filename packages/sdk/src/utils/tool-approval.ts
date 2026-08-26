const TOOL_ALIASES: Record<string, string | string[]> = {
  agent: 'Agent',
  askuser: 'AskUserQuestion',
  askuserquestion: 'AskUserQuestion',
  bash: 'Bash',
  edit: 'Edit',
  editfile: 'Edit',
  glob: 'Glob',
  grep: 'Grep',
  listdirectory: ['Glob', 'ls'],
  listdir: ['Glob', 'ls'],
  listmcpresources: 'ListMcpResourcesTool',
  listmcpresourcestool: 'ListMcpResourcesTool',
  notebookedit: 'NotebookEdit',
  read: 'Read',
  readfile: 'Read',
  readmcpresource: 'ReadMcpResourceTool',
  readmcpresourcetool: 'ReadMcpResourceTool',
  skill: 'Skill',
  taskcreate: 'TaskCreate',
  taskget: 'TaskGet',
  tasklist: 'TaskList',
  taskstop: 'TaskStop',
  processoutput: 'ProcessOutput',
  processstop: 'ProcessStop',
  taskupdate: 'TaskUpdate',
  todo: 'TodoWrite',
  todowrite: 'TodoWrite',
  toolsearch: 'ToolSearch',
  webfetch: 'WebFetch',
  websearch: 'WebSearch',
  write: 'Write',
  writefile: 'Write',
}

function normalizeToolKey(value: string): string {
  return value.trim().replace(/[-_\s]/g, '').toLowerCase()
}

function canonicalToolNames(value: string): string[] {
  const resolved = TOOL_ALIASES[normalizeToolKey(value)]
  if (Array.isArray(resolved)) return resolved
  return [resolved ?? value]
}

export function matchesToolPattern(
  toolName: string,
  pattern: string,
): boolean {
  if (!pattern) return false
  if (pattern.endsWith('*')) {
    // Case-insensitive prefix match on the raw names: alias normalization here
    // would strip the mcp__ structure from wildcard prefixes (#379).
    const prefix = pattern.slice(0, -1).toLowerCase()
    return toolName.toLowerCase().startsWith(prefix)
  }
  if (toolName === pattern) return true
  const toolNames = canonicalToolNames(toolName)
  const patternNames = canonicalToolNames(pattern)
  // Case-insensitive so unknown MCP-style names match regardless of casing (#379).
  return toolNames.some((name) =>
    patternNames.some((patternName) => patternName.toLowerCase() === name.toLowerCase()),
  )
}

export function matchesAnyToolPattern(
  toolName: string,
  patterns?: string[],
): boolean {
  if (!patterns || patterns.length === 0) return false
  return patterns.some((pattern) => matchesToolPattern(toolName, pattern))
}
