# MCP 真实接入设计

> 日期: 2026-05-23
> 状态: spec review 已通过，等待用户复核
> 范围: 工作区 MCP 配置、Alice-style MCP Manager、设置页诊断、运行时工具注入、资源读取、认证诊断

## 概述

Lume 需要把现有 MCP 配置能力升级为真实连接能力：设置页能连接、测试并展示 MCP 服务状态，Agent 运行时能调用 stdio、SSE、Streamable HTTP 服务暴露的工具，并能读取 MCP resources。

用户确认采用 Alice 的设计方向：在主进程/sidecar 中维护持久 MCP 客户端管理器，而不是只在单次 Agent run 中临时按配置连接。Lume 会借鉴 Alice 的连接生命周期、自动重连、工具详情诊断和配置导入体验，但不照搬其实现；Lume 保留自己的 workspace 边界、工具命名、权限审批和 runtime event 管线。

## 当前背景

Lume 已经有一部分 MCP 基础：

- `apps/web/src/components/settings/McpSettings.tsx` 已有 MCP 设置 UI，但状态主要来自配置推断，不是真实连接状态。
- `packages/shared/src/types/agent.ts` 已定义 `McpServerEntry`、`WorkspaceMcpConfig`，现有传输类型是 `stdio | http | sse`。
- `apps/sidecar/src/services/agent/agent-workspace-manager.ts` 已负责 workspace MCP 配置读写，并合并 `lume.yaml` 的工作区配置。
- `apps/sidecar/src/services/agent-runtime/runtime-core/run.ts` 已把 enabled MCP 配置映射到 SDK Agent options。
- `packages/sdk/src/mcp/client.ts` 已经能用 `@modelcontextprotocol/sdk` 连接 stdio、SSE、Streamable HTTP，并把 MCP tools 包装成 `mcp__${serverName}__${toolName}`。
- `packages/sdk/src/tools/mcp-resource-tools.ts` 已有 list/read/subscribe/unsubscribe resources 的工具层雏形。

Alice 的可参考设计：

- 设置里把 MCP servers 存成数组配置，字段包含 `id`、`name`、`transport`、`command`、`args`、`env`、`url`、`headers`、`enabled`。
- 传输协议使用 `stdio`、`sse`、`streamable_http`。
- 主进程有一个 MCP client manager，按 server id 持有 config、client、tools、connecting promise。
- `ensureConnected` 避免重复连接，`doConnect` 按 transport 创建 `StdioClientTransport`、`SSEClientTransport` 或 `StreamableHTTPClientTransport`。
- 连接后调用 `listTools`，状态返回 connected、tool names、toolDetails、inputSchema。
- 工具调用时按 server id 优先定位；连接类错误会清掉 client，重连一次并重试。
- 设置页支持 JSON 导入、测试连接、展开工具详情。

## 目标

1. 支持真实连接 stdio、SSE、Streamable HTTP MCP 服务。
2. 引入 workspace-scoped MCP manager，让 sidecar 持有每个工作区的连接状态。
3. 保存 MCP 配置后自动同步连接：enabled server 自动连接或重连，disabled server 断开。
4. 设置页展示真实状态、错误原因、工具数量、工具详情和 input schema。
5. Agent 运行时从 MCP manager 注入可调用工具，而不是只根据配置推断。
6. 支持 MCP resources 的 list/read，先不扩展到完整订阅体验。
7. 认证第一版只支持静态 `env` 与 `headers`，同时把 401/403 等情况归类为 `auth_needed`。
8. 保持已有 `http` 配置兼容，不破坏现有 workspace MCP 配置文件。

## 非目标

- 不在第一版实现 OAuth 完整授权流。
- 不在第一版把 Lume 自身暴露成 MCP server；这是独立的 open-platform 方向。
- 不新增依赖；继续复用已有 `@modelcontextprotocol/sdk`。
- 不引入全局 MCP 配置继承或自动读取 Claude/Cursor 全局配置。
- 不重写整个 ToolRuntime，只补齐 MCP 作为工具源进入现有权限与事件管线。
- 不让设置页成为任意工具执行控制台；工具调用诊断可以保留为内部/dev 能力。
- 不在第一版实现 MCP resource subscription 的产品体验；已有订阅工具后续再接入 manager。
- 不在第一版实现 secret 加密存储；先保证显示、日志、事件脱敏。

## 配置模型

Lume 第一版继续以 workspace 配置为准：workspace MCP JSON 与 `lume.yaml` 工作区覆盖合并后形成有效配置。

新的规范字段使用 `transport`，传输值为：

- `stdio`
- `streamable_http`
- `sse`

为了兼容现有配置，解析层继续接受旧字段：

- `type: "http"` 等同于 `transport: "streamable_http"`
- `type: "stdio"` 等同于 `transport: "stdio"`
- `type: "sse"` 等同于 `transport: "sse"`

建议的共享类型形态：

```ts
type McpTransport = 'stdio' | 'streamable_http' | 'sse'
type LegacyMcpTransport = 'stdio' | 'http' | 'sse'

interface McpServerEntry {
  name: string
  enabled: boolean
  transport?: McpTransport
  type?: McpTransport | LegacyMcpTransport
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
}
```

保存新配置时只写 canonical `transport`。读取旧配置时接受 `type` 旧值但不强制迁移文件；用户下次保存时再写入 canonical 形态。这是单向兼容规则：read accepts legacy, write emits canonical。

### 身份与命名规则

MCP server 必须有稳定身份，避免重命名、导入和同名工具影响权限审计：

- `serverId` 是稳定主键，来自 workspace MCP config 的 record key。
- 标准 JSON 导入 `{ "mcpServers": { "id": { ... } } }` 时，外层 key 就是 `serverId`。
- 若未来支持数组导入，数组项的 `id` 可作为 `serverId`；没有 `id` 时根据 `name` 生成一次性 slug。
- `name` 只是展示名，可修改，不参与权限 key、resource key 或 tool wrapper 名称。
- 手动新增时根据用户输入生成 `serverId`，保存后不随展示名变化。
- 若导入的 `serverId` 与现有 server 冲突，UI 必须要求覆盖或重命名，不能静默合并。

工具 wrapper 名称使用 canonical namespace：

- server segment 使用 `serverId` 规范化结果，而不是 display name。
- MCP 原始 tool name 保存在 `originalToolName`，wrapper segment 使用规范化后的 tool name。
- 规范化只允许 ASCII 字母、数字、下划线和连字符；其他字符替换为 `_`，连续 `_` 合并，空值拒绝保存。
- 若同一 server 内规范化后 tool name 冲突，后续项追加稳定短后缀，并在 `McpToolDetail` 中保留原名与 wrapper 名映射。
- 稳定短后缀来自 `serverId + "\0" + originalToolName` 的短 hash，确保跨 session 不漂移。

因此对模型暴露的工具名仍是 `mcp__server__tool` 形态，但其中的 `server` 是稳定 `serverId` namespace。

## 架构

### SDK MCP Manager

在 SDK 中从现有 `packages/sdk/src/mcp/client.ts` 提取一个可复用 manager，负责单 workspace 内的 MCP 连接生命周期：

- `register(serverId, config)`
- `sync(configs)`
- `ensureConnected(serverId)`
- `connect(serverId)`
- `disconnect(serverId)`
- `dispose()`
- `getStatus()`
- `getTools(serverId?)`
- `callTool(serverId, originalToolName, args, options)`
- `listResources(serverId?)`
- `readResource(serverId, uri)`

manager 内部每个 server 持有：

```ts
interface McpServerRuntimeState {
  config: NormalizedMcpServerConfig
  client?: Client
  transport?: unknown
  tools: McpToolDetail[]
  connecting?: Promise<void>
  status: 'idle' | 'connecting' | 'connected' | 'failed'
  error?: McpClientError
  lastConnectedAt?: number
  lastCheckedAt?: number
}
```

SDK manager 只处理 MCP 协议、连接、重试、结果规范化和资源读取；它不直接理解 Lume workspace、设置页、权限审批或 runtime event。

错误边界：

- SDK manager 返回技术错误：`invalid_config`、`transport_error`、`protocol_error`、`timeout`、`auth_error`。
- SDK manager 不做 workspace 日志、不生成用户可见文案、不决定审批策略。
- Sidecar manager 把 SDK 技术错误映射为公开状态：`disconnected`、`connecting`、`connected`、`error`、`auth_needed`。
- Sidecar manager 负责脱敏、用户可见错误摘要、RPC payload 和 runtime event 元数据。

### Sidecar Workspace MCP Manager

在 sidecar 增加工作区级 manager，例如：

`apps/sidecar/src/services/mcp/workspace-mcp-manager.ts`

职责：

- 按 `workspaceSlug` 持有 SDK MCP Manager。
- 从 `AgentWorkspaceManager` 读取有效 MCP 配置。
- 在配置保存后调用 `syncWorkspace(workspaceSlug)`。
- 给 RPC handler 提供 `getStatus`、`testServer`、`listResources`、`readResource`。
- 给 Agent runtime 提供当前 workspace 的 MCP tool definitions。
- 在 workspace 关闭、配置删除、app 退出时 dispose 连接。

sidecar manager 是 Lume 的边界层：这里负责状态分类、日志脱敏、workspace 生命周期和 RPC payload。

### Agent Runtime 集成

Agent run 启动时不再把同一份 workspace MCP 配置同时交给旧的 per-run `mcpServers` 路径和新的 workspace manager。新的流程是：

1. runtime 根据 `workspaceSlug` 请求 `WorkspaceMcpManager.ensureWorkspaceConnected(workspaceSlug)`。
2. manager 返回 connected servers 的 `McpToolDetail[]`。
3. runtime 把每个 MCP tool 包装成 Lume ToolDefinition，名称保持 `mcp__${serverIdNamespace}__${toolNameNamespace}`。
4. 工具执行仍走现有 ToolRuntime/gateway/approval/event 管线。
5. 真正调用时由 wrapper 转发到 `WorkspaceMcpManager.callTool(workspaceSlug, serverId, originalToolName, args, signal)`。

这样 MCP 工具和内置工具一样进入权限、日志、取消、超时与结果治理路径，同时保留 Alice-style 的持久连接和设置页诊断。

过渡规则：

- Phase 1 到 Phase 3 可以保留现有 per-run MCP 代码，但 runtime 仍只走旧路径。
- Phase 4 切换 runtime 时，必须停用或删除 `buildMcpServers/mapWorkspaceMcpConfig` 对 workspace MCP 的注入，避免重复连接、重复工具和事件路径分裂。
- 若为了回滚保留旧实现，只能放在互斥开关后；同一次 Agent run 中只能有一个 MCP 工具来源。
- Runtime wrapper 必须保存 `serverId` 和 `originalToolName`，调用 manager 时不依赖展示名或规范化后的 wrapper 名反查。

### Agent Resource 工具

MCP resources 不作为每个 resource 的独立工具注入。第一版复用现有 resource tool 语义，但 handler 改为调用 workspace manager：

- list 工具输入：可选 `serverId`，不传时聚合当前 workspace 已连接 servers。
- read 工具输入：必填 `serverId` 与 `uri`。
- 输出包含 `serverId`、`serverName`、`uri`、`mimeType` 与内容；大内容遵循同一截断策略。
- 不再依赖 SDK 全局 `setMcpConnections` 作为 Lume sidecar runtime 的状态源。
- subscribe/unsubscribe 保留为非目标，不进入第一版 UI 和 runtime 计划。

## 数据流

### 设置页加载

1. Web 调用现有 workspace MCP 配置读取 RPC。
2. Web 调用新增 `agent:get-mcp-status`。
3. Sidecar 返回每个 server 的真实状态、工具详情、错误摘要和最近检查时间。
4. 设置页用真实状态替换当前的配置推断状态。

### 配置保存

1. Web 提交配置。
2. Sidecar normalize 并校验 transport、command/url、headers/env。
3. `AgentWorkspaceManager` 保存 workspace 配置。
4. `WorkspaceMcpManager.syncWorkspace(workspaceSlug)` 自动断开删除/禁用服务，并为 enabled 服务启动连接。
5. 保存 RPC 不等待所有远端服务完成连接；它返回保存结果和初始 `connecting` 状态，避免单个慢服务卡住设置页。
6. Web 刷新状态；用户点击测试时再等待单个 server 的连接结果。

### Agent 调用 MCP 工具

1. Agent run 启动时获取 workspace MCP tools。
2. 模型选择 `mcp__server__tool`。
3. ToolRuntime 执行权限判断。
4. wrapper 调用 `WorkspaceMcpManager.callTool`。
5. manager 确保连接存在；连接类错误重连一次后重试。
6. 结果转换成 Lume tool result，并保留截断标记。
7. 单个 MCP server 连接失败时，该 server 的工具本次不注入；其他已连接 server 不受影响。

### Resource 读取

1. 设置页或 Agent resource tool 调用 `agent:list-mcp-resources`。
2. Sidecar 聚合 connected servers 的 resources；若指定 `serverId`，只访问该 server。
3. 聚合读取允许部分失败，返回成功 resources 和按 server 分组的 errors。
4. 读取具体 resource 时必须带 server id 与 uri，避免跨 server uri 冲突。

## 错误处理与认证诊断

连接状态使用：

- `connected`: 已连接并成功列出工具。
- `connecting`: 正在连接，复用同一个 connecting promise。
- `disconnected`: 未启用、未连接或已手动断开。
- `error`: 配置错误、进程启动失败、网络错误、协议错误。
- `auth_needed`: HTTP/SSE 返回 401/403，或错误消息明显指向 missing/invalid token、unauthorized、forbidden。

Sidecar/public 错误码由 SDK 技术错误映射而来，用于 UI、RPC 和 runtime event 展示：

- stdio 缺少 command: `invalid_config`
- command 不存在或 spawn 失败: `spawn_failed`
- URL 解析失败: `invalid_config`
- fetch failed、ECONNREFUSED、ECONNRESET、socket hang up: `connection_failed`
- 401/403/unauthorized/invalid token: `auth_needed`
- MCP initialize/listTools/callTool 失败: `protocol_error`

默认超时：

- connect: 15 秒。
- initialize/listTools: 15 秒。
- listResources/readResource: 15 秒。
- callTool: 30 秒。

设置页测试只等待单个 server 的测试超时。配置保存后的自动 sync 不阻塞所有连接完成。Agent 启动时按 server 独立连接；超时或失败的 server 标记为 error，本次 run 不注入它的工具，但不阻止其他 MCP server 或内置工具继续工作。

连接类错误只重连并重试一次，避免无限循环。超大结果沿用 Lume 的结果治理；若当前通道没有统一限制，MCP manager 先设置约 200k 字符的保护性上限，并追加截断元数据。

所有日志、runtime events、设置页错误都必须脱敏：

- 不打印 headers 完整值。
- `Authorization`、`Cookie`、`X-API-Key`、`token`、`secret` 等字段显示为 masked。
- stdio 环境变量只存用户配置部分，连接时可与 `process.env` 合并，但 UI 和日志不展示合并后的完整环境。

## UI 设计

`McpSettings` 改成真实服务控制台：

- 列表展示 server name、transport、enabled、真实状态、工具数量、最近检查时间。
- 状态 badge 使用 `connected`、`connecting`、`auth_needed`、`error`、`disconnected`。
- 每个 server 提供测试、启用/禁用、编辑、删除。
- 展开后展示 tools；点击 tool 打开详情，展示 description 与 input schema。
- stdio 表单展示 command、args、env。
- Streamable HTTP/SSE 表单展示 url、headers。
- JSON 导入支持标准 `{ "mcpServers": { "id": { ... } } }`，也支持直接 `{ "id": { ... } }`。
- 若导入项有 `url` 但没有 transport/type，默认使用 `streamable_http`。
- 若导入项有 `command` 但没有 transport/type，默认使用 `stdio`。
- auth_needed 状态展示“需要检查 headers 或 token”，但不回显 secret。
- 测试按钮测试已保存 server；编辑中的 draft 先保存再连接测试。

当前设置页中无法反映真实连接的占位状态与示例集成信息应删除或改成真实配置列表，避免误导。

## RPC 与共享类型

新增或扩展共享类型：

```ts
interface McpToolDetail {
  name: string // 兼容字段，值等同 originalName
  originalName: string
  wrapperName: string // 完整 ToolRuntime 名称，如 mcp__server__tool
  description?: string
  inputSchema?: unknown
  serverId: string
  serverName: string // 展示名
}

interface McpServerStatus {
  serverId: string
  name: string
  transport: McpTransport
  enabled: boolean
  status: 'disconnected' | 'connecting' | 'connected' | 'error' | 'auth_needed'
  tools: string[] // wrapperName 列表
  toolDetails: McpToolDetail[]
  error?: {
    code: string
    message: string
  }
  lastConnectedAt?: number
  lastCheckedAt?: number
}

interface McpResourceSummary {
  serverId: string
  serverName: string
  uri: string
  name?: string
  description?: string
  mimeType?: string
}
```

RPC 能力：

- `agent:get-mcp-status`
- `agent:test-mcp-server`
- `agent:list-mcp-resources`
- `agent:read-mcp-resource`
- `agent:call-mcp-tool` 仅作为诊断/dev 能力；Agent 运行时不依赖 Web 直接调用这个 RPC。

RPC payload 约定：

```ts
interface GetMcpStatusRequest {
  workspaceSlug: string
}

interface GetMcpStatusResponse {
  servers: McpServerStatus[]
}

interface TestMcpServerRequest {
  workspaceSlug: string
  serverId: string
}

interface TestMcpServerResponse {
  status: McpServerStatus
}

interface ListMcpResourcesRequest {
  workspaceSlug: string
  serverId?: string
}

interface ListMcpResourcesResponse {
  resources: McpResourceSummary[]
  errors?: Record<string, { code: string; message: string }>
}

interface ReadMcpResourceRequest {
  workspaceSlug: string
  serverId: string
  uri: string
}

interface ReadMcpResourceResponse {
  contents: Array<{
    uri: string
    mimeType?: string
    text?: string
    blobBase64?: string
  }>
  truncated?: boolean
}

interface CallMcpToolDiagnosticRequest {
  workspaceSlug: string
  serverId: string
  originalToolName: string
  args: Record<string, unknown>
  timeoutMs?: number
}

interface CallMcpToolDiagnosticResponse {
  result?: {
    text?: string
    structuredContent?: unknown
    truncated?: boolean
  }
  error?: {
    code: string
    message: string
  }
}
```

`agent:test-mcp-server` 第一版只测试已保存的 server。编辑表单可以做本地字段校验；连接测试要求先保存配置，这样不会引入未保存 draft 连接的生命周期问题。

## 权限与安全

MCP 工具来自外部进程或远程服务，默认不能视为可信内置工具。第一版策略：

- 未知 MCP tool 默认进入 Lume 现有审批机制。
- 若 MCP tool metadata/annotations 明确为 read-only，后续可以降级风险；第一版先 fail-closed。
- 工具名保持 server 前缀，避免不同 server 的同名 tool 冲突。
- Agent 调用必须带 server id，不能只按 tool name 在多个 server 中模糊查找。
- MCP resource read 也必须带 server id。
- 配置里的 secret 必须脱敏展示和脱敏记录。

这与 Alice 的便捷调用不同：Alice 在同名工具时会找第一个并给 warning，Lume 为了权限与可审计性选择显式 server id。

## 测试策略

只补与本功能直接相关的测试：

- 配置 normalize：`type: "http"` 兼容为 `transport: "streamable_http"`。
- server identity：导入 key、展示名重命名、冲突处理和 canonical wrapper name 稳定。
- JSON 导入：标准 `mcpServers` 与直接对象两种形态。
- transport 选择：stdio、sse、streamable_http 分别选对 SDK transport。
- 状态分类：invalid_config、connection_failed、auth_needed、protocol_error。
- RPC payload：workspaceSlug/serverId 必填规则、resource 聚合部分失败、diagnostic call 错误响应。
- manager 连接：同 server 并发 ensureConnected 只触发一次连接。
- 工具列表：toolDetails 保留 inputSchema，并生成稳定 wrapper 名称。
- 工具调用：连接错误重试一次，超大结果截断。
- runtime 注入：只有 enabled 且 connected 的工具进入 ToolRuntime。
- resource 工具：list 可选 serverId，read 必填 serverId+uri，并从 workspace manager 取数。
- 权限路径：MCP tool 默认触发现有审批策略。
- UI 状态：connected/error/auth_needed 渲染、工具详情弹层、secret 脱敏。

不需要为了文档或纯样式改动运行全量 lint/test。

## 实施阶段

1. 共享类型与配置兼容层：添加 canonical transport、status、tool/resource 类型，保留旧 `http` 读取。
2. SDK MCP manager：从现有 client 抽出连接生命周期、状态、工具调用、资源读取。
3. Sidecar workspace manager 与 RPC：按 workspace 持有连接，配置保存后自动 sync。
4. Runtime 工具注入：从 manager 生成 MCP ToolDefinition，走现有权限与 event 管线。
5. Settings UI：替换假状态，加入测试、toolDetails、JSON 导入、secret 脱敏。
6. 聚焦验证：运行 MCP 相关单测和必要 runtime/UI 测试，不做无关全量验证。

## 风险与约束

- 长连接 stdio 进程会占资源；必须在禁用、删除、workspace 关闭和 app 退出时 dispose。
- SSE 是 legacy transport，但仍需保留兼容；错误处理可能比 Streamable HTTP 更不稳定。
- headers/env secret 第一版仍存于 workspace 配置文件；只能先做好脱敏，后续再评估加密存储。
- OAuth 未实现时，部分远程 MCP 服务只能显示 `auth_needed`，无法在 Lume 内完成授权。
- 多 workspace 同时打开大量 MCP 服务时会带来进程和连接压力；manager 需要支持按 workspace dispose。
- 现有 SDK Agent 的 per-run MCP 连接路径与新 manager 会短期并存；实施时应避免重复连接同一 server。

## 成功标准

- 用户能在设置页添加 stdio、SSE、Streamable HTTP 服务并看到真实连接状态。
- 成功连接后，设置页能展示工具数量、工具详情和 input schema。
- 修改并保存配置后，enabled 服务自动重连，disabled 或删除的服务自动断开。
- Agent 可以调用 MCP 工具，工具名保持 `mcp__server__tool`，调用进入现有权限和事件管线。
- MCP resources 可以按 server list/read。
- 认证失败能显示 `auth_needed`，且 UI、日志、runtime event 不泄露 secret。
- 旧的 `type: "http"` workspace 配置仍能读取并正常连接 Streamable HTTP 服务。
