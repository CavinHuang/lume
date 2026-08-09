# P1: Link 消费层从 REST 改为 MCP 设计

**日期**: 2026-08-07
**分支**: `codex/link-mcp-consume`(stacked on `codex/link-openconnector`,PR#32)
**状态**: 设计已确认,待实现(writing-plans)

## 背景

P0(PR#32)把 OpenConnector 打包 bundle 化(187MB→62MB)。P1 是 follow-up:消费层 `create-link-tools.ts` 当前走 REST `/v1/` 调本地 OpenConnector,提供 4 工具 + 6 层治理。OpenConnector 原生是 MCP server(`src/mcp.ts` 5 元工具,Streamable HTTP),Lume 已有完整 MCP 消费能力(`McpClientManager` + `WorkspaceMcpManager`)。

P1 消除 `create-link-tools` 与 OpenConnector 之间的平行 REST runtime 桥接层,改走 MCP。

## 方案:混合(已确认)

保留 4-tool 门面 + 6 层治理不变,底层 `linkRuntimeRequest("/v1/")` 换成 `McpClientManager.callTool`。**不走 `WorkspaceMcpManager`**(那会把 5 元工具注入 agent,破坏 4-tool 门面)。

## 设计

### 1. 架构与 MCP 连接

**不变**:
- `createLinkTools()` 4 工具(`link_list_apps`/`link_search_actions`/`link_inspect_actions`/`link_call_action`)签名 + `runtimeMetadata` + 对外行为
- 6 层治理上层逻辑(inspect 前置、`classifyAction`、`waitForToolPermissionDecision`、`acquireCallSlot`、OAuth 信号)留 `create-link-tools.ts`
- supervisor(fork `openconnector.mjs` + origin/token)
- `link-client` admin 通路(`/api/`、`adminToken`)——连接器/OAuth 管理 UI 仍 REST(无 MCP 替代)

**变化**:
- `link-client.ts` 新增 MCP 客户端单例(`McpClientManager`):`installLinkRuntimeBootstrap` 收到 online(origin + runtimeToken)时,`register("openconnector", {transport:"streamable_http", url:${origin}/mcp, headers:{authorization:"Bearer "+runtimeToken}})` + `ensureConnected`
- 4 工具底层 `linkRuntimeRequest("/v1/...")` → `callLinkMcpTool`
- `linkRuntimeRequest` 的 runtime 分支(`/v1/`)退役;admin 分支(`linkAdminRequest` `/api/`)保留

### 2. 工具映射

| Lume 工具(不变) | OpenConnector MCP 工具 |
|---|---|
| `link_list_apps(service?)` | `list_apps(query?)` |
| `link_search_actions(query,service,limit)` | `search_actions(query,service,limit)` |
| `link_inspect_actions(actions[],connName)` | `get_action_guide(actionId,connName)` × `Promise.all` |
| `link_call_action(service,action,input,connName)` | `execute_action(actionId=service.action, input, connName)` |

### 3. 6 层治理在 MCP 路径的状态

| 治理层 | 状态 |
|---|---|
| ① inspect 前置 | ✅ 保留(查 `inspectedActions`,数据源 `get_action_guide`) |
| ② `classifyAction` 风险分级 | ⚠️ readOnly 快路径退化(MCP 不暴露 readOnly),退化为纯动词判断(偏保守) |
| ③ 写权限门 | ✅ 保留 |
| ④ 幂等 | ⚠️ server 端失效(MCP 不传 idempotency-key),接受边缘损失 |
| ⑤ 节流 | ✅ 保留 |
| ⑥ OAuth 信号回流 | ✅ 保留(从 MCP `error.code` 映射 `AUTH_CODES`) |

### 4. 3 个适配点(已确认处理)

- **A(`classifyAction` readOnly)**:接受(保守安全,极少数 action 误判为 write 触发权限门)
- **B(幂等)**:接受边缘损失(YAGNI,不引入客户端幂等缓存);follow-up 可扩展 OpenConnector MCP 支持 idempotency
- **C(`list_apps` 精确 vs 模糊)**:客户端后过滤(callTool 后按 `service` 字段精确匹配,行为零变化)

### 5. 错误处理

`callLinkMcpTool(toolName, args)` 提取 MCP `CallToolResult.structuredContent` = `{ok, data, error}`:
- `ok=true` → 返回 `data`
- `ok=false` → `error.code` 匹配 `AUTH_CODES` → 上抛 `LinkApiError(code)`(由第⑥层转 `LinkAuthorizationSignal`);其他 → `LinkApiError`
- MCP transport 错误(`McpClientManager.classifyError`:transport_error/timeout/aborted/auth_error)→ 直接 throw(让 agent 感知连接问题,不伪装业务错误)

### 6. 测试

- `create-link-tools.test.ts`(已存在,129 行)mock 从 `linkRuntimeRequest` → `callLinkMcpTool`/`McpClientManager.callTool`
- 验证 4 工具 + 6 层治理在 MCP 路径下行为不变
- 新增:适配 C(list_apps 后过滤)+ A(readOnly 退化)case

### 7. 实现文件(3)

| 文件 | 改动 |
|---|---|
| `apps/sidecar/src/services/link/link-client.ts` | **核心**:新增 MCP 客户端单例(`McpClientManager` + `callLinkMcpTool`),bootstrap online 时连 `${origin}/mcp`;`linkRuntimeRequest` runtime 分支(`/v1/`)退役;admin `/api/` 保留 |
| `apps/sidecar/src/services/agent-runtime/tools/link/create-link-tools.ts` | 4 工具底层 `linkRuntimeRequest` → `callLinkMcpTool`;适配 C(list_apps 后过滤)+ A(classifyAction 接受 readOnly 缺失) |
| `apps/sidecar/src/services/agent-runtime/tools/link/create-link-tools.test.ts` | mock 换 MCP + 新适配 case |

### 8. 基线

stacked on `codex/link-openconnector`(P0,PR#32)。P1 PR base 暂指 P0 分支,P0 合并 main 后 retarget main。

## 非目标

- 不改 OpenConnector(`src/mcp.ts` 不动)
- 不走 `WorkspaceMcpManager` 通用注入(保 4-tool 门面)
- 不补偿幂等边缘损失(YAGNI)
