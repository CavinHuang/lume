// Web MCP shim 工厂（移植自 Codex comment-preload.js 的 g()）。
// 网页侧 shim：让网页通过 registerTool 注册 MCP 工具，由消费侧（如 invokeWebMcpTool）调用。
// 纯 TS：无 electron/DOM 依赖，locationLike 注入，registrationId 用 crypto.randomUUID。

/** 注入的页面位置信息（替代 Codex 中读取全局 location）。 */
export interface WebMcpLocationLike {
  origin?: string
  href?: string
}

/** 网页侧注册工具时的入参定义。 */
export interface WebMcpToolDefinition {
  name: string
  execute: (input: unknown, client: WebMcpClient) => unknown | Promise<unknown>
  title?: string
  description?: string
  /** 任意可 JSON 序列化的 inputSchema（shim 会 JSON.stringify 后存储）。 */
  inputSchema?: unknown
  annotations?: Record<string, unknown>
}

/** 注册工具时的可选项。 */
export interface WebMcpRegisterOptions {
  /** abort 后自动注销该工具（对齐 Codex g() 的 signal 处理）。 */
  signal?: AbortSignal
}

/** 暴露给注册方 execute 回调的 client（仅 requestUserInteraction，且当前不支持）。 */
export interface WebMcpClient {
  requestUserInteraction(): Promise<never>
}

/** getTools() 返回的公开工具形态（不含 registrationId）。 */
export interface WebMcpPublicTool {
  name: string
  inputSchema: string | null
  title?: string
  description?: string
  annotations?: Record<string, unknown>
  origin?: string
  pageUrl?: string
}

/** codexGetTools() 返回的内部工具形态（含 registrationId，用于 staleness 校验）。 */
export interface WebMcpInternalTool extends WebMcpPublicTool {
  registrationId: string
}

/** executeTool / codexExecuteTool 入参里的工具引用。 */
export interface WebMcpToolRef {
  name: string
  registrationId?: string
}

/** 内部存储的工具记录（包含 execute 与 registrationId）。 */
interface WebMcpToolRecord {
  name: string
  registrationId: string
  execute: WebMcpToolDefinition['execute']
  title?: string
  description?: string
  inputSchema?: string
  annotations?: Record<string, unknown>
}

export interface WebMcpShim {
  registerTool(tool: WebMcpToolDefinition, options?: WebMcpRegisterOptions): void
  unregisterTool(name: string): boolean
  getTools(): WebMcpPublicTool[]
  codexGetTools(): WebMcpInternalTool[]
  executeTool(tool: WebMcpToolRef, inputJson: string): Promise<string>
  codexExecuteTool(tool: WebMcpToolRef, inputJson: string): Promise<string>
}

/** 安全调用 onToolsChanged（吞掉异常，对齐 Codex _）。 */
function safeCall(fn: (() => void) | undefined): void {
  try {
    fn?.()
  } catch {
    // 忽略回调异常
  }
}

/** 校验工具名（对齐 Codex v）。 */
function validateName(name: unknown): string {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw Error('WebMCP tools must have a non-empty name.')
  }
  return name.trim()
}

interface ExecuteRegisteredArgs {
  client: WebMcpClient
  getRegisteredTool: (name: string) => WebMcpToolRecord | undefined
  input: unknown
  registrationId?: string
  toolName?: string
  validateRegistration: boolean
}

/** 查找工具并校验 staleness（对齐 Codex y）。 */
async function executeRegistered({
  client,
  getRegisteredTool,
  input,
  registrationId,
  toolName,
  validateRegistration,
}: ExecuteRegisteredArgs): Promise<unknown> {
  const name = validateName(toolName)
  const record = getRegisteredTool(name)
  if (record == null) {
    throw Error(
      validateRegistration
        ? `WebMCP tool ${JSON.stringify(name)} is stale. Call fetchTools() again.`
        : `WebMCP tool not found: ${name}`,
    )
  }
  if (validateRegistration && record.registrationId !== registrationId) {
    throw Error(`WebMCP tool ${JSON.stringify(name)} is stale. Call fetchTools() again.`)
  }
  return await record.execute(input, client)
}

/** 序列化 execute 结果（对齐 Codex b）：undefined → null，再 JSON.stringify。 */
function serializeResult(result: unknown, stringify: (value: unknown) => string): string {
  const normalized = result === undefined ? null : result
  try {
    const text = stringify(normalized)
    if (text === undefined) {
      throw Error('WebMCP tool result is not JSON-serializable.')
    }
    return text
  } catch {
    throw Error('WebMCP tool result is not JSON-serializable.')
  }
}

/**
 * 创建一个 Web MCP shim 实例（移植自 Codex g()）。
 *
 * 设计要点：
 * - registerTool：校验 name 非空 + execute 函数 + inputSchema JSON 序列化 + registrationId(uuid)
 *   + AbortSignal 自动注销 + 触发 onToolsChanged
 * - unregisterTool：移除并触发 onToolsChanged，返回是否删除
 * - getTools()：公开形态（不含 registrationId，含 origin/pageUrl 来自 locationLike）
 * - codexGetTools()：内部形态（含 registrationId）
 * - executeTool(tool, jsonString)：JSON.parse 输入 → execute → JSON.stringify 输出
 * - codexExecuteTool(tool, jsonString)：严格 registrationId 校验（stale 抛错）
 * - requestUserInteraction：throw "not supported"
 * - 返回对象 Object.freeze（不可变）
 */
export function createWebMcpShim(options: {
  locationLike?: WebMcpLocationLike
  onToolsChanged?: () => void
} = {}): WebMcpShim {
  const locationLike = options.locationLike ?? {}
  const onToolsChanged = options.onToolsChanged
  const tools = new Map<string, WebMcpToolRecord>()

  const client: WebMcpClient = {
    async requestUserInteraction() {
      throw Error('requestUserInteraction is not supported by the Codex WebMCP shim.')
    },
  }

  const registerTool = (tool: WebMcpToolDefinition, opts?: WebMcpRegisterOptions): void => {
    const name = validateName(tool?.name)
    const execute = tool.execute
    if (typeof execute !== 'function') {
      throw Error(`WebMCP tool ${name} is missing an execute callback.`)
    }
    const inputSchemaText = tool.inputSchema === undefined ? undefined : JSON.stringify(tool.inputSchema)
    if (tool.inputSchema !== undefined && inputSchemaText === undefined) {
      throw Error('WebMCP tool inputSchema must be JSON-serializable.')
    }
    const record: WebMcpToolRecord = {
      name,
      registrationId: crypto.randomUUID(),
      execute,
      ...(tool.title == null ? {} : { title: tool.title }),
      ...(tool.description == null ? {} : { description: tool.description }),
      ...(inputSchemaText === undefined ? {} : { inputSchema: inputSchemaText }),
      ...(tool.annotations == null ? {} : { annotations: { ...tool.annotations } }),
    }
    const signal = opts?.signal
    // 已 abort 的 signal 直接跳过注册（对齐 Codex g）
    if (!signal?.aborted) {
      if (typeof signal?.addEventListener === 'function') {
        signal.addEventListener(
          'abort',
          () => {
            // 仅当 map 里仍是同一把 record 时才注销（避免覆盖竞态）
            if (tools.get(name) === record) {
              tools.delete(name)
              safeCall(onToolsChanged)
            }
          },
          { once: true },
        )
      }
      tools.set(name, record)
      safeCall(onToolsChanged)
    }
  }

  const unregisterTool = (name: string): boolean => {
    const deleted = tools.delete(validateName(name))
    if (deleted) safeCall(onToolsChanged)
    return deleted
  }

  const shapePublic = (record: WebMcpToolRecord): WebMcpPublicTool => ({
    name: record.name,
    inputSchema: record.inputSchema ?? null,
    ...(record.title == null ? {} : { title: record.title }),
    ...(record.description == null ? {} : { description: record.description }),
    ...(record.annotations == null ? {} : { annotations: { ...record.annotations } }),
    ...(locationLike.origin == null ? {} : { origin: locationLike.origin }),
    ...(locationLike.href == null ? {} : { pageUrl: locationLike.href }),
  })

  const getTools = (): WebMcpPublicTool[] => {
    const list: WebMcpPublicTool[] = []
    tools.forEach((record) => {
      list[list.length] = shapePublic(record)
    })
    return list
  }

  const codexGetTools = (): WebMcpInternalTool[] => {
    const list: WebMcpInternalTool[] = []
    tools.forEach((record) => {
      list[list.length] = { ...shapePublic(record), registrationId: record.registrationId }
    })
    return list
  }

  const runExecute = async (
    tool: WebMcpToolRef,
    inputJson: string,
    validateRegistration: boolean,
  ): Promise<string> => {
    let parsed: unknown
    try {
      parsed = JSON.parse(inputJson)
    } catch {
      throw Error('WebMCP executeTool requires a JSON-stringified input.')
    }
    const result = await executeRegistered({
      client,
      getRegisteredTool: (name) => tools.get(name),
      input: parsed,
      registrationId: tool?.registrationId,
      toolName: tool?.name,
      validateRegistration,
    })
    return serializeResult(result, JSON.stringify)
  }

  const executeTool = (tool: WebMcpToolRef, inputJson: string): Promise<string> =>
    runExecute(tool, inputJson, false)

  const codexExecuteTool = (tool: WebMcpToolRef, inputJson: string): Promise<string> =>
    runExecute(tool, inputJson, true)

  return Object.freeze({
    codexExecuteTool,
    codexGetTools,
    executeTool,
    getTools,
    registerTool,
    unregisterTool,
  })
}
