/**
 * MCP Resource Tools
 *
 * ListMcpResources / ReadMcpResource - Access resources from MCP servers.
 */

import type { ToolDefinition, ToolResult } from '../types.js'
import type { MCPConnection } from '../mcp/client.js'

// Registry of MCP connections (set by the agent)
let mcpConnections: MCPConnection[] = []
const mcpResourceSubscriptions = new Map<string, Set<string>>()
const mcpPollingSubscriptions = new Map<string, NodeJS.Timeout>()

// Polling timers are unbounded work: a cap keeps a model loop over
// SubscribePolling from parking hundreds of permanent timers (#228).
const MAX_POLLING_SUBSCRIPTIONS = 50

function pollingServer(key: string): string {
  return key.slice(0, key.indexOf(':'))
}

function stopPollingTimer(key: string, timer: NodeJS.Timeout): void {
  clearInterval(timer)
  mcpPollingSubscriptions.delete(key)
}

/**
 * Set MCP connections for resource access.
 */
export function setMcpConnections(connections: MCPConnection[]): void {
  // Timers close over the old connections; dropping the table without
  // clearing them leaks one spinning timer per subscription (#228).
  const liveServers = new Set(connections.map((connection) => connection.name))
  for (const [key, timer] of mcpPollingSubscriptions) {
    if (!liveServers.has(pollingServer(key))) {
      stopPollingTimer(key, timer)
    }
  }
  mcpConnections = connections
}

function getConnection(serverName: string): MCPConnection | undefined {
  return mcpConnections.find((connection) => connection.name === serverName)
}

export const ListMcpResourcesTool: ToolDefinition = {
  name: 'ListMcpResourcesTool',
  description: 'List available resources from connected MCP servers.',
  inputSchema: {
    type: 'object',
    properties: {
      server: { type: 'string', description: 'Filter by MCP server name' },
    },
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
  async prompt() { return 'List MCP resources.' },
  async call(input: any): Promise<ToolResult> {
    const connections = input.server
      ? mcpConnections.filter(c => c.name === input.server)
      : mcpConnections

    if (connections.length === 0) {
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: '[]',
      }
    }

    const results: Array<{
      uri: string
      name: string
      mimeType?: string
      description?: string
      server: string
    }> = []

    for (const conn of connections) {
      if (conn.status !== 'connected') continue

      try {
        const resources = await conn.listResources()
        if (resources?.length) {
          for (const r of resources) {
            results.push({
              uri: r.uri,
              name: r.name || r.uri,
              mimeType: r.mimeType,
              description: r.description,
              server: conn.name,
            })
          }
        }
      } catch {
        // Ignore resource listing failures for individual servers.
      }
    }

    return {
      type: 'tool_result',
      tool_use_id: '',
      content: JSON.stringify(results, null, 2),
    }
  },
}

export const ReadMcpResourceTool: ToolDefinition = {
  name: 'ReadMcpResourceTool',
  description: 'Read a specific resource from an MCP server.',
  inputSchema: {
    type: 'object',
    properties: {
      server: { type: 'string', description: 'MCP server name' },
      uri: { type: 'string', description: 'Resource URI to read' },
    },
    required: ['server', 'uri'],
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
  async prompt() { return 'Read an MCP resource.' },
  async call(input: any): Promise<ToolResult> {
    const conn = getConnection(input.server)
    if (!conn) {
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: `MCP server not found: ${input.server}`,
        is_error: true,
      }
    }

    try {
      const result = await conn.readResource(input.uri)
      if (result?.contents) {
        const contents = result.contents.map((c: any) => ({
          uri: c.uri,
          mimeType: c.mimeType,
          text: c.text,
        }))
        return {
          type: 'tool_result',
          tool_use_id: '',
          content: JSON.stringify({ contents }, null, 2),
        }
      }
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: JSON.stringify({ contents: [] }),
      }
    } catch (err: any) {
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: `Error reading resource: ${err.message}`,
        is_error: true,
      }
    }
  },
}

export const SubscribeMcpResourceTool: ToolDefinition = {
  name: 'SubscribeMcpResource',
  description: 'Subscribe to updates for a specific MCP resource URI.',
  inputSchema: {
    type: 'object',
    properties: {
      server: { type: 'string', description: 'MCP server name' },
      uri: { type: 'string', description: 'Resource URI to subscribe to' },
    },
    required: ['server', 'uri'],
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
  async prompt() { return 'Subscribe to an MCP resource.' },
  async call(input: any): Promise<ToolResult> {
    const conn = getConnection(input.server)
    if (!conn) {
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: `MCP server not found: ${input.server}`,
        is_error: true,
      }
    }

    try {
      await conn.subscribeResource(input.uri)
      const set = mcpResourceSubscriptions.get(input.server) || new Set<string>()
      set.add(input.uri)
      mcpResourceSubscriptions.set(input.server, set)
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: JSON.stringify({
          subscribed: true,
          server: input.server,
          uri: input.uri,
        }),
      }
    } catch (err: any) {
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: `Error subscribing to resource: ${err.message}`,
        is_error: true,
      }
    }
  },
}

export const UnsubscribeMcpResourceTool: ToolDefinition = {
  name: 'UnsubscribeMcpResource',
  description: 'Unsubscribe from updates for a specific MCP resource URI.',
  inputSchema: {
    type: 'object',
    properties: {
      server: { type: 'string', description: 'MCP server name' },
      uri: { type: 'string', description: 'Resource URI to unsubscribe from' },
    },
    required: ['server', 'uri'],
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
  async prompt() { return 'Unsubscribe from an MCP resource.' },
  async call(input: any): Promise<ToolResult> {
    const conn = getConnection(input.server)
    if (!conn) {
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: `MCP server not found: ${input.server}`,
        is_error: true,
      }
    }

    try {
      await conn.unsubscribeResource(input.uri)
      const set = mcpResourceSubscriptions.get(input.server)
      set?.delete(input.uri)
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: JSON.stringify({
          subscribed: false,
          server: input.server,
          uri: input.uri,
        }),
      }
    } catch (err: any) {
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: `Error unsubscribing from resource: ${err.message}`,
        is_error: true,
      }
    }
  },
}

export const SubscribePollingTool: ToolDefinition = {
  name: 'SubscribePolling',
  description: 'Poll an MCP resource periodically and keep the subscription alive.',
  inputSchema: {
    type: 'object',
    properties: {
      server: { type: 'string', description: 'MCP server name' },
      uri: { type: 'string', description: 'Resource URI to poll' },
      interval_ms: { type: 'number', description: 'Polling interval in milliseconds (default: 1000)' },
    },
    required: ['server', 'uri'],
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
  async prompt() { return 'Subscribe to MCP polling updates.' },
  async call(input: any): Promise<ToolResult> {
    const conn = getConnection(input.server)
    if (!conn) {
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: `MCP server not found: ${input.server}`,
        is_error: true,
      }
    }

    const key = `${input.server}:${input.uri}`
    const existing = mcpPollingSubscriptions.get(key)
    if (existing) {
      clearInterval(existing)
    } else if (mcpPollingSubscriptions.size >= MAX_POLLING_SUBSCRIPTIONS) {
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: `Polling subscription limit reached (${MAX_POLLING_SUBSCRIPTIONS}); unsubscribe one first.`,
        is_error: true,
      }
    }

    const intervalMs = Math.max(200, Math.min(Number(input.interval_ms || 1000), 60000))
    const timer = setInterval(() => {
      void conn.readResource(input.uri).catch(() => undefined)
    }, intervalMs)
    timer.unref?.()
    mcpPollingSubscriptions.set(key, timer)

    return {
      type: 'tool_result',
      tool_use_id: '',
      content: JSON.stringify({
        subscribed: true,
        server: input.server,
        uri: input.uri,
        interval_ms: intervalMs,
      }),
    }
  },
}

export const UnsubscribePollingTool: ToolDefinition = {
  name: 'UnsubscribePolling',
  description: 'Stop polling a subscribed MCP resource.',
  inputSchema: {
    type: 'object',
    properties: {
      server: { type: 'string', description: 'MCP server name' },
      uri: { type: 'string', description: 'Resource URI to stop polling' },
    },
    required: ['server', 'uri'],
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
  async prompt() { return 'Unsubscribe from MCP polling.' },
  async call(input: any): Promise<ToolResult> {
    const key = `${input.server}:${input.uri}`
    const timer = mcpPollingSubscriptions.get(key)
    if (timer) {
      stopPollingTimer(key, timer)
    }

    return {
      type: 'tool_result',
      tool_use_id: '',
      content: JSON.stringify({
        subscribed: false,
        server: input.server,
        uri: input.uri,
      }),
    }
  },
}

export const McpAuthTool: ToolDefinition = {
  name: 'McpAuth',
  description: 'Start authentication for an MCP server that requires OAuth or URL-based authorization.',
  inputSchema: {
    type: 'object',
    properties: {
      server: { type: 'string', description: 'MCP server name' },
    },
    required: ['server'],
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
  async prompt() { return 'Authenticate an MCP server.' },
  async call(input: any): Promise<ToolResult> {
    const conn = getConnection(input.server)
    if (!conn) {
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: `MCP server not found: ${input.server}`,
        is_error: true,
      }
    }

    const url = (conn.config as any).url
    if (!url) {
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: JSON.stringify({
          status: 'unsupported',
          message: `Server "${input.server}" does not expose a URL-based auth flow.`,
        }),
      }
    }

    return {
      type: 'tool_result',
      tool_use_id: '',
      content: JSON.stringify({
        status: 'auth_url',
        authUrl: url,
        message: `Ask the user to authenticate the MCP server by opening: ${url}`,
      }),
    }
  },
}
