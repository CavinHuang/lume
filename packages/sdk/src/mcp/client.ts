/**
 * MCP Client - Connect to Model Context Protocol servers
 */

import type {
  ToolDefinition,
  McpServerConfig,
  ToolResult,
} from '../types.js'
import { SandboxedStdioClientTransport } from './sandboxed-stdio-transport.js'

export interface MCPConnection {
  name: string
  status: 'connected' | 'disconnected' | 'error'
  enabled: boolean
  config: McpServerConfig | any
  tools: ToolDefinition[]
  error?: string
  _client?: any
  listResources: () => Promise<any[]>
  readResource: (uri: string) => Promise<any>
  subscribeResource: (uri: string) => Promise<void>
  unsubscribeResource: (uri: string) => Promise<void>
  close: () => Promise<void>
}

/**
 * Connect to an MCP server and fetch its tools.
 */
export async function connectMCPServer(
  name: string,
  config: McpServerConfig,
): Promise<MCPConnection> {
  // #311:提前声明,catch 清理时可安全引用(错误可能发生在 Client 构造之前)
  let client: any
  try {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
    const {
      ElicitRequestSchema,
      ElicitResultSchema,
      ElicitationCompleteNotificationSchema,
    } = await import('@modelcontextprotocol/sdk/types.js')

    let transport: any

    if (!config.type || config.type === 'stdio') {
      const stdioConfig = config as Extract<McpServerConfig, { type?: 'stdio' }>
      // Minimal safe env subset, not the host's full environment (#201)
      const { StdioClientTransport, getDefaultEnvironment } = await import('@modelcontextprotocol/sdk/client/stdio.js')
      if (stdioConfig.sandbox?.processIsolation?.enabled) {
        transport = new SandboxedStdioClientTransport({
          command: stdioConfig.command,
          args: stdioConfig.args || [],
          env: { ...getDefaultEnvironment(), ...stdioConfig.env } as Record<string, string>,
          cwd: stdioConfig.cwd,
          sandbox: stdioConfig.sandbox,
        })
      } else {
        transport = new StdioClientTransport({
          command: stdioConfig.command,
          args: stdioConfig.args || [],
          env: { ...getDefaultEnvironment(), ...stdioConfig.env } as Record<string, string>,
          cwd: stdioConfig.cwd,
        })
      }
    } else if (config.type === 'sse') {
      const sseConfig = config as { url: string; headers?: Record<string, string> }
      const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js')
      transport = new SSEClientTransport(new URL(sseConfig.url), {
        requestInit: sseConfig.headers ? { headers: sseConfig.headers } : undefined,
      } as any)
    } else if (config.type === 'http' || config.type === 'streamable_http') {
      const httpConfig = config as { url: string; headers?: Record<string, string> }
      const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
      transport = new StreamableHTTPClientTransport(new URL(httpConfig.url), {
        requestInit: httpConfig.headers ? { headers: httpConfig.headers } : undefined,
      } as any)
    } else {
      throw new Error(`Unsupported MCP transport type: ${(config as any).type}`)
    }

    let connection: MCPConnection
    client = new Client(
      { name: `agent-sdk-${name}`, version: '1.0.0' },
      {
        capabilities: (config as any).onElicitation
          ? {
              elicitation: {
                form: {},
                url: {},
              },
            }
          : {},
        listChanged: {
          tools: {
            onChanged: async (_error, tools) => {
              if (!connection || !tools) return
              connection.tools = (tools || []).map((tool: any) =>
                createMCPToolDefinition(name, tool, client),
              )
              await (config as any).onResourceUpdate?.({
                serverName: name,
                kind: 'tools',
                reason: 'list_changed',
              })
            },
          },
          resources: {
            onChanged: async () => {
              await (config as any).onResourceUpdate?.({
                serverName: name,
                kind: 'resources',
                reason: 'list_changed',
              })
            },
          },
        },
      },
    )

    await client.connect(transport)

    if ((config as any).onElicitation) {
      client.setRequestHandler(ElicitRequestSchema, async (request: any) => {
        const response = await (config as any).onElicitation({
          serverName: name,
          message: request.params.message,
          mode: request.params.type === 'url' ? 'url' : 'form',
          url: request.params.url,
          elicitationId: request.params.elicitationId,
          requestedSchema: request.params.requestedSchema,
        })

        return ElicitResultSchema.parse({
          action: response.action,
          content: response.content,
        })
      })
    }

    client.setNotificationHandler(
      ElicitationCompleteNotificationSchema,
      async (notification: any) => {
        await (config as any).onResourceUpdate?.({
          serverName: name,
          kind: 'elicitation_complete',
          elicitationId: notification.params.elicitationId,
        })
      },
    )

    // Fetch available tools
    const toolList = await client.listTools()
    const tools: ToolDefinition[] = (toolList.tools || []).map((mcpTool: any) =>
      createMCPToolDefinition(name, mcpTool, client),
    )

    connection = {
      name,
      status: 'connected',
      enabled: true,
      config,
      tools,
      _client: client,
      async listResources() {
        const result = await client.listResources?.()
        return result?.resources || []
      },
      async readResource(uri: string) {
        return client.readResource?.({ uri })
      },
      async subscribeResource(uri: string) {
        await client.subscribeResource?.({ uri })
      },
      async unsubscribeResource(uri: string) {
        await client.unsubscribeResource?.({ uri })
      },
      async close() {
        try {
          await client.close()
        } catch {
          // ignore close errors
        }
      },
    }
    return connection
  } catch (err: any) {
    console.error(`[MCP] Failed to connect to "${name}": ${err.message}`)
    // #311:connect/listTools 半途失败不清理会泄漏 stdio 子进程——占位 close 是
    // 空函数,closeAllConnections 收不回,每次重试多一个孤儿。best-effort 关闭。
    try {
      await client?.close()
    } catch {
      // ignore cleanup errors
    }
    return {
      name,
      status: 'error',
      enabled: true,
      config,
      tools: [],
      error: err.message,
      listResources: async () => [],
      readResource: async () => undefined,
      subscribeResource: async () => {},
      unsubscribeResource: async () => {},
      async close() {},
    }
  }
}

/**
 * 单次 MCP 工具调用上限：hung server 原样裸调会永久 await 并卡死 mutation
 * 串行道。给足 5 分钟（长任务工具的合理上界），可用环境变量覆盖。
 */
const MCP_TOOL_TIMEOUT_MS = (() => {
  const parsed = Number.parseInt(process.env.LUME_MCP_TOOL_TIMEOUT_MS ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 300_000
})()

function withCallTimeout<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
    const onAbort = () => reject(new Error('aborted'))
    signal?.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

/**
 * Create a ToolDefinition wrapping an MCP server tool.
 */
function createMCPToolDefinition(
  serverName: string,
  mcpTool: { name: string; description?: string; inputSchema?: any },
  client: any,
): ToolDefinition {
  const toolName = `mcp__${serverName}__${mcpTool.name}`

  return {
    name: toolName,
    description: mcpTool.description || `MCP tool: ${mcpTool.name} from ${serverName}`,
    inputSchema: mcpTool.inputSchema || { type: 'object', properties: {} },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isEnabled: () => true,
    async prompt() {
      return mcpTool.description || ''
    },
    async call(input: any, context?: { abortSignal?: AbortSignal }): Promise<ToolResult> {
      try {
        const result = await withCallTimeout(
          Promise.resolve(client.callTool({
            name: mcpTool.name,
            arguments: input,
          })),
          `MCP tool "${toolName}"`,
          MCP_TOOL_TIMEOUT_MS,
          context?.abortSignal,
        )

        // Extract text content from MCP result
        let output = ''
        if (result.content) {
          for (const block of result.content) {
            if (block.type === 'text') {
              output += block.text
            } else {
              output += JSON.stringify(block)
            }
          }
        } else {
          output = JSON.stringify(result)
        }

        return {
          type: 'tool_result',
          tool_use_id: '',
          content: output,
          is_error: result.isError || false,
        }
      } catch (err: any) {
        return {
          type: 'tool_result',
          tool_use_id: '',
          content: `MCP tool error: ${err.message}`,
          is_error: true,
        }
      }
    },
  }
}

/**
 * Close all MCP connections.
 */
export async function closeAllConnections(connections: MCPConnection[]): Promise<void> {
  await Promise.allSettled(connections.map((c) => c.close()))
}
