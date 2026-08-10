# Link 消费层 REST→MCP(P1)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `create-link-tools.ts` 的 4 工具底层从 REST `/v1/`(`linkRuntimeRequest`)换成 MCP 消费(`McpClientManager.callTool` 调 OpenConnector 5 元工具),保留 4-tool 门面与 6 层治理。

**Architecture:** `link-client.ts` 新增 MCP 客户端单例(基于 Lume 已有 `McpClientManager`),`installLinkRuntimeBootstrap` online 时连 `${origin}/mcp`;新增 `callLinkMcpTool(toolName, args)` 提取 OpenConnector 的 `{ok,data,error}` payload。`create-link-tools.ts` 接受可选 `mcpCaller` 注入(默认 `callLinkMcpTool`),4 工具底层换用它,admin `/api/` 通路与 6 层治理上层逻辑不动。

**Tech Stack:** TypeScript、`@modelcontextprotocol/sdk`、`bun:test`、Electron UtilityProcess(sidecar)。

## Global Constraints

- 不改 OpenConnector 源码(`src/mcp.ts` 不动,它已暴露 5 元工具:list_apps/list_connections/search_actions/get_action_guide/execute_action)
- 保留 4-tool 门面(`link_list_apps`/`link_search_actions`/`link_inspect_actions`/`link_call_action`)的签名与 `runtimeMetadata`,对外行为基本不变
- admin 通路(`linkAdminRequest` `/api/`)完全保留(连接器/OAuth 管理 UI 无 MCP 替代)
- 3 适配点(已确认):A `classifyAction` readOnly 快路径退化(接受,偏保守);B server 端幂等失效(接受边缘损失);C `list_apps` 客户端后过滤(精确 service)
- stacked on `codex/link-openconnector`(P0,PR#32);P1 worktree `D:/workspace/projects/ai-projects/lume-link-mcp-consume`
- 提交信息 emoji 前缀;Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

## File Structure

- `apps/sidecar/src/services/link/link-client.ts` — 新增:`extractMcpPayload`(纯函数)、`callLinkMcpTool`、MCP 客户端单例(`getLinkMcpClient`)、bootstrap online 时 register+connect。退役:`linkRuntimeRequest` 的 `/v1/` runtime 分支(保留 `linkAdminRequest` `/api/`、`LinkApiError`、`installLinkRuntimeBootstrap`、`isLinkRuntimeOnline`)
- `apps/sidecar/src/services/agent-runtime/tools/link/create-link-tools.ts` — `createLinkTools` 加可选 `mcpCaller` 参数(默认 `callLinkMcpTool`);4 工具底层换 `mcpCaller`;适配 C(list_apps 后过滤)、A(inspect 换 get_action_guide,readOnly 缺失由 classifyAction 退化处理)
- `apps/sidecar/src/services/agent-runtime/tools/link/create-link-tools.test.ts` — mock 从 `globalThis.fetch` → 注入 `mcpCaller`;新增适配 C/A case

## Interfaces

- `extractMcpPayload(result: unknown): McpLinkPayload`(纯函数,Task 1 产出)
- `type McpLinkPayload = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } }`(Task 1 产出)
- `callLinkMcpTool(toolName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpLinkPayload>`(Task 1 产出;内部 `getLinkMcpClient().ensureConnected("openconnector")` + `callTool("openconnector", toolName, args, { signal })` + `extractMcpPayload`)
- `createLinkTools({ threadId, runId?, emitToolPermissionRequest, mcpCaller? })`(Task 2 改;`mcpCaller` 默认 `callLinkMcpTool`,签名同 `callLinkMcpTool`)

---

### Task 1: link-client MCP 客户端(extractMcpPayload + callLinkMcpTool + 单例 + bootstrap 连接)

**Files:**
- Modify: `apps/sidecar/src/services/link/link-client.ts`
- Test: `apps/sidecar/src/services/link/link-client.test.ts`(新建,若无;复用已有则追加)

**Interfaces:**
- Produces: `extractMcpPayload`、`McpLinkPayload`、`callLinkMcpTool`、`getLinkMcpClient`
- Consumes: `McpClientManager`(`packages/sdk/src/mcp/manager.ts`)、`installLinkRuntimeBootstrap` 的 origin/runtimeToken(本文件已有)

- [ ] **Step 1: 写 extractMcpPayload 的失败测试**

新建/追加 `link-client.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { extractMcpPayload } from "./link-client";

describe("extractMcpPayload", () => {
  test("prefers structuredContent payload", () => {
    const r = extractMcpPayload({ structuredContent: { ok: true, data: { x: 1 } } });
    expect(r).toEqual({ ok: true, data: { x: 1 } });
  });
  test("parses content[0].text JSON when no structuredContent", () => {
    const r = extractMcpPayload({ content: [{ type: "text", text: JSON.stringify({ ok: false, error: { code: "connection_not_found", message: "Connect GitHub" } }) }] });
    expect(r).toEqual({ ok: false, error: { code: "connection_not_found", message: "Connect GitHub" } });
  });
  test("returns unknown error on unparseable", () => {
    const r = extractMcpPayload({ content: [{ type: "text", text: "not json" }] });
    expect(r).toEqual({ ok: false, error: { code: "link_mcp_invalid_payload", message: "OpenConnector MCP returned an incompatible payload." } });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/sidecar && bun test src/services/link/link-client.test.ts`
Expected: FAIL(`extractMcpPayload` 未导出)

- [ ] **Step 3: 实现 extractMcpPayload + McpLinkPayload 类型**

在 `link-client.ts` 加入:
```ts
export type McpLinkPayload =
  | { ok: true; data: unknown }
  | { ok: false; error: { code: string; message: string } };

export function extractMcpPayload(result: unknown): McpLinkPayload {
  const r = result as { structuredContent?: unknown; content?: Array<{ text?: string }> };
  if (r && typeof r.structuredContent === "object" && r.structuredContent !== null) {
    const p = r.structuredContent as McpLinkPayload;
    if (p && (p.ok === true || p.ok === false)) return p;
  }
  const text = r?.content?.[0]?.text;
  if (typeof text === "string") {
    try {
      const parsed = JSON.parse(text) as McpLinkPayload;
      if (parsed && (parsed.ok === true || parsed.ok === false)) return parsed;
    } catch { /* fall through */ }
  }
  return { ok: false, error: { code: "link_mcp_invalid_payload", message: "OpenConnector MCP returned an incompatible payload." } };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/sidecar && bun test src/services/link/link-client.test.ts`
Expected: PASS(3/3)

- [ ] **Step 5: 实现 callLinkMcpTool + MCP 客户端单例 + bootstrap 连接**

在 `link-client.ts` 加入(import `McpClientManager` from `@lume/sdk` 或相对路径,按现有 sdk 导入惯例):
```ts
import { McpClientManager } from "../../../.../mcp/manager"; // 按现有 sdk import 惯例调整

const LINK_MCP_SERVER_ID = "openconnector";
let mcpClient: McpClientManager | null = null;

export function getLinkMcpClient(): McpClientManager {
  if (!mcpClient) mcpClient = new McpClientManager();
  return mcpClient;
}

// 在 installLinkRuntimeBootstrap 的 online 分支里(register + 连接):
//   getLinkMcpClient().register(LINK_MCP_SERVER_ID, {
//     enabled: true, transport: "streamable_http",
//     url: `${origin}/mcp`, headers: { authorization: `Bearer ${runtimeToken}` },
//   });
//   void getLinkMcpClient().connect(LINK_MCP_SERVER_ID).catch((e) => console.warn("[link] mcp connect failed", e));
// offline/disabled 分支:disconnect(已在 bootstrap 切换时由 sync/register 覆盖)

export async function callLinkMcpTool(toolName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpLinkPayload> {
  const client = getLinkMcpClient();
  await client.ensureConnected(LINK_MCP_SERVER_ID);
  const result = await client.callTool(LINK_MCP_SERVER_ID, toolName, args, signal ? { signal } : {});
  return extractMcpPayload(result);
}
```
注:`installLinkRuntimeBootstrap` 现有结构(online 时存 origin/adminToken/runtimeToken 到 bootstrap)在 Task 1 扩展:online 时额外 register+connect MCP。`NormalizedMcpServerConfig` 字段(enabled/transport/url/headers)按 `packages/sdk` 定义(实现时核对字段名)。

- [ ] **Step 6: typecheck**

Run: `cd apps/sidecar && bun run typecheck`
Expected: 无 error

- [ ] **Step 7: commit**

```bash
git add apps/sidecar/src/services/link/link-client.ts apps/sidecar/src/services/link/link-client.test.ts
git commit -m "✨ feat(sidecar): link MCP 客户端(callLinkMcpTool + McpClientManager 单例)"
```

---

### Task 2: create-link-tools 4 工具换 mcpCaller + 适配 C(list_apps 后过滤)

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/tools/link/create-link-tools.ts`
- Modify: `apps/sidecar/src/services/agent-runtime/tools/link/create-link-tools.test.ts`

**Interfaces:**
- Consumes: `callLinkMcpTool`、`McpLinkPayload`(Task 1)
- Produces: `createLinkTools({ ..., mcpCaller? })`(默认 `callLinkMcpTool`)

- [ ] **Step 1: 改 test 注入 mock mcpCaller(失败)**

`create-link-tools.test.ts` 顶部 import 改:
```ts
import { callLinkMcpTool, type McpLinkPayload } from "../../../link/link-client";
```
把每个 test 里 `globalThis.fetch = ...` 的 mock 改成构造一个 mock `mcpCaller` 并传入 `createLinkTools`。例(第一个 test 之外的工具行为 test):
```ts
let mcpCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
const mcpCaller = async (name: string, args: Record<string, unknown>): Promise<McpLinkPayload> => {
  mcpCalls.push({ name, args });
  if (name === "list_apps") return { ok: true, data: [{ service: "github", displayName: "GitHub", categories: [], authTypes: ["api_key"], actionCount: 1, executableActionCount: 1 }] };
  if (name === "search_actions") return { ok: true, data: [{ id: "github.create_issue", service: "github", name: "Create issue" }] };
  if (name === "get_action_guide") return { ok: true, data: { id: args.actionId, service: "github", name: "Create issue" } };
  if (name === "execute_action") return { ok: true, data: { ok: true } };
  return { ok: false, error: { code: "connection_not_found", message: "Connect GitHub" } };
};
const tools = createLinkTools({ threadId: "thread", runId: "run", emitToolPermissionRequest: () => {}, mcpCaller });
```
"exactly the four governed tools" test 仍只验工具名列表(不调 mcpCaller),保持。其余 test 按上面模式替换 fetch mock。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/sidecar && bun test src/services/agent-runtime/tools/link/create-link-tools.test.ts`
Expected: FAIL(`mcpCaller` 参数不存在 / 仍调 fetch)

- [ ] **Step 3: createLinkTools 加 mcpCaller 参数 + 4 工具换底层 + 适配 C**

`create-link-tools.ts`:
```ts
import { callLinkMcpTool, type McpLinkPayload } from "../../../link/link-client";

type McpCaller = (toolName: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<McpLinkPayload>;

export function createLinkTools(input: {
  threadId: string;
  runId?: string;
  emitToolPermissionRequest: (request: AgentToolPermissionRequest) => void;
  mcpCaller?: McpCaller; // 默认 callLinkMcpTool
}): ToolDefinition[] {
  if (!isLinkRuntimeOnline()) return [];
  const mcpCaller = input.mcpCaller ?? callLinkMcpTool;
  const inspectedActions = new Map<string, LinkActionDetail>();
  // ... link_list_apps:
  //   const payload = await mcpCaller("list_apps", service ? { query: service } : {}, context.abortSignal);
  //   if (!payload.ok) throw new LinkApiError(payload.error.code, payload.error.message);
  //   const apps = Array.isArray(payload.data) ? payload.data : [];
  //   const filtered = service ? apps.filter((a) => a?.service === service) : apps; // 适配 C:精确 service 后过滤
  //   return result(context.toolUseId, filtered);
  // ... link_search_actions: mcpCaller("search_actions", { query, service, limit })
  // ... link_inspect_actions: Promise.all(actions.map(id => mcpCaller("get_action_guide", { actionId: id, connectionName }))) → 每个 payload.data 构造 LinkActionDetail({ id, service, name, ...(data.readOnly ? { readOnly: true } : {}) }) 存 inspectedActions
  // ... link_call_action: mcpCaller("execute_action", { actionId: `${service}.${action}`, input, connectionName }) —— 6 层治理不变
}
```
注:适配 A——`get_action_guide` 不返回 readOnly,`LinkActionDetail` 无 readOnly 字段时 `classifyAction` 走 verbs 路径(已接受)。inspect 的 service 校验(`detail.service !== service`)用 get_action_guide 返回的 service。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/sidecar && bun test src/services/agent-runtime/tools/link/create-link-tools.test.ts`
Expected: PASS(全部 5 test;mock mcpCaller 生效)

- [ ] **Step 5: typecheck**

Run: `cd apps/sidecar && bun run typecheck`
Expected: 无 error

- [ ] **Step 6: commit**

```bash
git add apps/sidecar/src/services/agent-runtime/tools/link/create-link-tools.ts apps/sidecar/src/services/agent-runtime/tools/link/create-link-tools.test.ts
git commit -m "♻️ refactor(link): create-link-tools 底层换 callLinkMcpTool(MCP)+ list_apps 客户端过滤"
```

---

### Task 3: OAuth/错误映射验证 + 清理 /v1/ 残留 + 完整测试

**Files:**
- Modify: `apps/sidecar/src/services/link/link-client.ts`(退役 `/v1/` 分支)
- Verify: `apps/sidecar/src/services/agent-runtime/tools/link/create-link-tools.test.ts`

**Interfaces:**
- Consumes: Task 1/2 产出

- [ ] **Step 1: 加 OAuth 信号 + read-only 退化 case(失败→通过)**

`create-link-tools.test.ts` 加:
```ts
test("execute_action authorization error maps to link_authorization_required signal", async () => {
  installLinkRuntimeBootstrap({ phase: "online", origin: "http://127.0.0.1:51234", adminToken: "admin", runtimeToken: "runtime" });
  const mcpCaller = async (name: string): Promise<McpLinkPayload> =>
    name === "get_action_guide" ? { ok: true, data: { id: "github.list_issues", service: "github", name: "List issues" } }
    : { ok: false, error: { code: "connection_not_found", message: "Connect GitHub" } };
  const tools = createLinkTools({ threadId: "thread", emitToolPermissionRequest: () => {}, mcpCaller });
  await tools.find((t) => t.name === "link_inspect_actions")!.call({ actions: ["github.list_issues"] }, { cwd: ".", toolUseId: "i" } as never);
  const r = await tools.find((t) => t.name === "link_call_action")!.call({ service: "github", action: "github.list_issues", input: {} }, { cwd: ".", toolUseId: "c" } as never);
  expect(r).toMatchObject({ is_error: true, _meta: { link: { kind: "link_authorization_required", errorCode: "connection_not_found" } } });
});
```
跑 → 通过(Task 2 的 `!payload.ok → LinkApiError` + 第⑥层已覆盖)。

- [ ] **Step 2: 退役 linkRuntimeRequest 的 /v1/ runtime 分支**

`link-client.ts`:删除 `linkRuntimeRequest` 与 `linkRuntime` 的 `/v1/` runtime 分支(保留 `linkAdminRequest`/`linkAdmin` 的 `/api/` 分支、`LinkApiError`、`isLoopbackOrigin`、`installLinkRuntimeBootstrap`、`isLinkRuntimeOnline`、`getLinkRuntimePhase`)。确认无残留 import/引用(`create-link-tools.ts` 已不 import `linkRuntimeRequest`)。

- [ ] **Step 3: typecheck + 完整 sidecar 测试**

Run: `cd apps/sidecar && bun run typecheck && bun run test:unit`
Expected: 无 error,所有测试通过

- [ ] **Step 4: 清理 + commit**

```bash
git add apps/sidecar/src/services/link/link-client.ts apps/sidecar/src/services/agent-runtime/tools/link/create-link-tools.test.ts
git commit -m "♻️ refactor(link): 退役 /v1/ runtime REST 通路 + OAuth/错误映射验证"
```

- [ ] **Step 5: push(stacked PR)**

```bash
git push -u origin codex/link-mcp-consume
gh pr create --base codex/link-openconnector --head codex/link-mcp-consume --title "♻️ refactor(link): 消费层 REST→MCP(P1)" --body "..."
```
P0(PR#32)合并 main 后,将本 PR base retarget 到 main。

---

## Self-Review

**Spec coverage**:设计文档 8 节均覆盖——架构/MCP 连接(Task 1)、工具映射(Task 2)、6 层治理状态(Task 2 保留①③⑤⑥,Task 1/3 验证⑥,②退化④损失在设计已确认)、3 适配点(Task 2 C/A,Task 1/3 B 接受)、错误处理(Task 1 extractMcpPayload + Task 3 OAuth)、测试(Task 1-3)、3 文件(Task 1/2/3)、stacked 基线(Task 3 Step 5)。✅

**Placeholder scan**:Task 1 Step 5 的 `NormalizedMcpServerConfig` 字段(enabled/transport/url/headers)标注"实现时核对"——这是必要的接口核对(非占位符),因 `packages/shared/src/mcp.ts` 路径未完全确认。其余步骤均含实际代码。✅(执行 Task 1 Step 5 前先 Read `packages/shared/src/mcp.ts` 确认 `NormalizedMcpServerConfig` 字段名)

**Type consistency**:`McpLinkPayload`、`extractMcpPayload`、`callLinkMcpTool`、`McpCaller`、`createLinkTools({mcpCaller})` 在 Task 1-3 名称一致。✅
