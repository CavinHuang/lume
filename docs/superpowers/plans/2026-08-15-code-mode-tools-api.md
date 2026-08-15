# P3 Code Mode — js REPL 泛化 tools.* API 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** js REPL 沙箱内暴露 `tools.*` API（`await tools.Name(params)`），可调用 agent 全部可见工具（含 P2 已晋升），经完整权限/hooks 管道；`tools.documentation()` 惰性返回 SDK 目录文本。

**Architecture:** 沙箱 → `lume_host_call {method}` → Rust host（**通用透传，无需改动**，`kernel.rs:721`）→ TS runtime-manager 路由到新 `toolRequest` 回调 → `js` 工具的 call() 接到 `context.executeNestedTool`（执行）/ `context.listAvailableTools`（目录）。SDK 文本在宿主侧生成（sidecar 纯函数，可测），沙箱侧只做 marshal（worker.js 未测试面最小化）。both 模式：native 工具照旧，`js` 只是新增可用形态，模型自选。

**Tech Stack:** TypeScript（sidecar/sdk）、bun:test；`apps/desktop/resources-src/node-repl/runtime/worker.js`（沙箱 JS，经 `scripts/build-node-repl-resources.mjs` 打包）。

**Spec:** `docs/superpowers/specs/2026-08-14-tool-injection-optimization-design.md`（P3 节）

## Global Constraints

- **Stacked 分支**：基于 `feat/tool-search-promotion`（PR#87，含 P1+P2）开发；PR base 设 `feat/tool-search-promotion`，随 #85/#87 合并链 retarget
- 不改 Rust（`lume_host_call` 通用透传已核实）；不改 P1/P2 已交付语义
- 权限：`tool_call` 必须经 `context.executeNestedTool` → `executeSingleTool` 完整管道（与 ExecuteTool 同面，无绕过）
- curated result 语义维持现状：REPL 内只有 print/write/return 进模型历史；嵌套执行的中间结果只进 session 事件
- 测试 bun:test；提交 emoji 前缀；注释英文（worker.js 现有注释为英文）
- `tools` 目录排除 `js` 工具自身（防嵌套沙箱递归）

## Ruling（计划内裁定）

- SDK 文本**宿主侧生成**（`tool_list` 返回含 `documentation` 字段），沙箱 `tools.documentation()` 原样返回 —— worker.js 无测试基建，把逻辑放可测的 sidecar 纯函数
- `tools.documentation` 与 `tools.call` 为保留名，与工具名冲突时保留名优先；Proxy 便捷访问 `tools.Name` 覆盖其余名字

---

### Task 1: ToolContext.listAvailableTools（sdk）

**Files:**
- Modify: `packages/sdk/src/types.ts`（ToolContext）
- Modify: `packages/sdk/src/engine.ts`（executeSingleTool 接线，~1642 toolContext 构建处）
- Test: `packages/sdk/src/engine.test.ts`（追加）

**Interfaces:**
- Produces:
  ```ts
  // types.ts ToolContext 追加
  /** Live snapshot of every tool this engine can call: native tools first, then deferred. */
  listAvailableTools?: () => Array<{ name: string; description: string; inputSchema: ToolDefinition['inputSchema'] }>
  ```
  engine 接线：`() => [...this.config.tools, ...(this.config.deferredTools ?? [])].map(({name, description, inputSchema}) => ({name, description, inputSchema}))`（读 config 现场，P2 晋升自动包含）

- [ ] **Step 1: 写失败测试**（engine.test.ts，复用既有 fixture：tools 含一个工具 + deferredTools 含另一个；经一个探针工具的 call 读 context.listAvailableTools 并写回结果）

```ts
test("listAvailableTools returns native plus deferred tools live", async () => {
  // fixture 风格随 engine.test.ts 既有模式（StaticProvider/collectResult）；探针工具不可命名 ToolSearch/ExecuteTool
  // 断言：首轮列出两个工具名；晋升（context.activateTools）后再列，deferred 工具仍在列表（已移入 native）
})
```

- [ ] **Step 2: 跑测试确认失败** — `bun test packages/sdk/src/engine.test.ts`，FAIL：listAvailableTools undefined
- [ ] **Step 3: 实现**（types.ts 一行 + engine.ts toolContext 构建处三行，模式照 activateTools）
- [ ] **Step 4: 跑测试确认通过** — 同 Step 2 命令，PASS
- [ ] **Step 5: 提交**

```bash
rtk git add packages/sdk/src/types.ts packages/sdk/src/engine.ts packages/sdk/src/engine.test.ts
rtk git commit -m "✨ feat(sdk): expose live tool catalog via ToolContext.listAvailableTools"
```

---

### Task 2: SDK 目录渲染纯函数 + toolRequest 桥（sidecar）

**Files:**
- Create: `apps/sidecar/src/services/agent-runtime/tools/node-repl/tool-catalog.ts`
- Test: `apps/sidecar/src/services/agent-runtime/tools/node-repl/tool-catalog.test.ts`
- Modify: `apps/sidecar/src/services/agent-runtime/tools/node-repl/node-repl-types.ts`（exec options 增 toolRequest）
- Modify: `apps/sidecar/src/services/agent-runtime/tools/node-repl/node-repl-runtime-manager.ts`（host_call 路由）
- Test: `apps/sidecar/src/services/agent-runtime/tools/node-repl/node-repl-contract.test.ts`（追加，已有该文件）

**Interfaces:**
- Produces:
  ```ts
  // tool-catalog.ts
  export interface CatalogTool { name: string; description: string; inputSchema: Record<string, unknown> }
  /** Render the agent tool catalog as TypeScript-flavored SDK text for the REPL. */
  export function renderToolCatalogSdk(tools: CatalogTool[]): string
  // 语义：每工具一节 —— `## name` + description（截断至 6 行）+ 参数签名
  //   `await tools.name({ /* inputSchema properties: name: type, ... */ })`
  // inputSchema.properties 无则 `await tools.name()`；类型映射 string/number/boolean/array/object→TS 名，未知→unknown
  // 头部一行总述：调用走正常权限审批；tools.call(name, params) 为显式形式
  export function buildToolCatalogResult(tools: CatalogTool[]): { tools: CatalogTool[]; documentation: string }
  ```
  ```ts
  // node-repl-types.ts — NodeReplRuntimeExecOptions 追加
  toolRequest?: (request: { method: "tool_call" | "tool_list"; args: Record<string, unknown> }, signal: AbortSignal) => Promise<unknown>
  // tool_call args: { name: string; params: Record<string, unknown> } → 返回 ToolResult 形状
  // tool_list args: {} → 返回 buildToolCatalogResult 形状
  ```
  runtime-manager 路由：`runtime_host_call` 处理处（~222 行）按 method 分流——`browser_request`/`computer_use`/auth 照旧；新增 `tool_call`/`tool_list` → `options.toolRequest`；未提供回调时返回结构化错误 `{ ok: false, error: "tools bridge is unavailable" }`（不 crash）

- [ ] **Step 1: 写失败测试**（tool-catalog.test.ts：多工具渲染、无参数工具、未知类型映射、description 截断、js 自身排除由调用方负责——本函数纯渲染）
- [ ] **Step 2: 确认失败** — `bun test apps/sidecar/src/services/agent-runtime/tools/node-repl/tool-catalog.test.ts`
- [ ] **Step 3: 实现 renderToolCatalogSdk/buildToolCatalogResult**（纯函数，无副作用）
- [ ] **Step 4: 确认通过**
- [ ] **Step 5: types + manager 路由 + contract 测试追加**（照 node-repl-contract.test.ts 既有模式：fake client 发 tool_call host call，断言回调被调、结果回传；未接回调时结构化错误）
- [ ] **Step 6: 跑 sidecar node-repl 全部测试** — `bun test apps/sidecar/src/services/agent-runtime/tools/node-repl/`
- [ ] **Step 7: 提交**

```bash
rtk git add apps/sidecar/src/services/agent-runtime/tools/node-repl/
rtk git commit -m "✨ feat(sidecar): tool-catalog SDK renderer and toolRequest bridge in node-repl runtime"
```

---

### Task 3: 沙箱 tools 全局（worker.js）

**Files:**
- Modify: `apps/desktop/resources-src/node-repl/runtime/worker.js`（新增 tools 全局，模式照既有 privilegedOperation/nodeRepl 定义处）

**Interfaces:**
- Consumes: host 侧 Task 2 的 `tool_call`/`tool_list`（worker 经既有 host-call 通道发送，方法名透传）
- Produces 沙箱 API：
  - `await tools.Name(params)` —— Proxy get，非保留名返回 `tools.call.bind(null, name)`
  - `await tools.call(name, params)` —— 显式形式；host_call `tool_call {name, params}`；结果失败（ok:false / is_error）时 throw `Error(错误文本)`，成功返回 `content`（string；非 string JSON.stringify）
  - `await tools.documentation()` —— host_call `tool_list {}`，返回 `.documentation` 字符串
  - 保留名：`call`、`documentation`、thenable 探测（`then` 返回 undefined 防止 await Proxy）

- [ ] **Step 1: 实现**（~40 行，紧邻既有 nodeRepl 定义区；注释英文；不引入新依赖）

```js
// Agent tool bridge: `await tools.Name(params)` routes through the host with
// normal permission checks; `await tools.documentation()` returns the catalog.
const TOOLS_RESERVED = new Set(["call", "documentation", "then"]);
async function toolsCall(name, params) {
  // hostCall 为 worker 既有发送原语（按实际函数名适配，如 privilegedOperation/lumeHostCall）
  const result = await hostCall("tool_call", { name, params: params ?? {} });
  const content = typeof result?.content === "string" ? result.content : JSON.stringify(result);
  if (result?.is_error) throw new Error(content);
  return content;
}
globalThis.tools = new Proxy({}, {
  get(_t, prop) {
    if (typeof prop !== "string") return undefined;
    if (prop === "documentation") return () => hostCall("tool_list", {}).then((r) => String(r?.documentation ?? ""));
    if (TOOLS_RESERVED.has(prop)) return prop === "call" ? toolsCall : undefined;
    return (params) => toolsCall(prop, params);
  }
});
```

（`hostCall` 以 worker.js 实际既有原语为准——实现者先读 privilegedOperation 与 lume_host_call 的发送路径再落笔；若发送原语带方法白名单，扩展之。）

- [ ] **Step 2: 语法验证** — `node --check apps/desktop/resources-src/node-repl/runtime/worker.js`（或 `bun build --no-bundle`）；沙箱级行为由 Task 4 的 fake-runtime e2e 在宿主侧覆盖协议两端
- [ ] **Step 3: 提交**

```bash
rtk git add apps/desktop/resources-src/node-repl/runtime/worker.js
rtk git commit -m "✨ feat(node-repl): expose agent tools bridge global in sandbox worker"
```

---

### Task 4: js 工具接线 + 指引 + e2e

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/tools/node-repl/create-node-repl-tools.ts`（js 工具 call 注入 toolRequest）
- Modify: `apps/sidecar/src/services/agent-runtime/tools/node-repl/node-repl-types.ts`（NODE_REPL_MCP_INSTRUCTIONS 追加一句）
- Test: `apps/sidecar/src/services/agent-runtime/tools/node-repl/create-node-repl-tools.test.ts`（追加，已有该文件）

**Interfaces:**
- Consumes: Task 1 `context.listAvailableTools`、`context.executeNestedTool`；Task 2 `toolRequest` 签名
- Produces: `registry.exec(threadId, execInput, {...options, toolRequest})` 中 toolRequest：
  - `tool_call` → `context.executeNestedTool({ toolName: args.name, params: args.params })`（返回 ToolResult 形状原样回传）
  - `tool_list` → `buildToolCatalogResult((context.listAvailableTools?.() ?? []).filter(t => t.name !== "js"))`（排除 js 自身）

- [ ] **Step 1: 写失败 e2e 测试**（create-node-repl-tools.test.ts，注入 fake NodeReplRuntimeRegistry —— 既有模式：fake 的 exec 捕获 options.toolRequest 并模拟沙箱调用）

```ts
test("js tool bridges tool_call and tool_list through the engine context", async () => {
  // fake registry: exec() 捕获 options.toolRequest，然后在 resolve 前调用
  //   await options.toolRequest({ method: "tool_list", args: {} }, signal)
  //   await options.toolRequest({ method: "tool_call", args: { name: "Read", params: { path: "x" } } }, signal)
  // context: listAvailableTools 返回 [js, Read]；executeNestedTool 记录并返回成功 ToolResult
  // 断言：tool_list 的 documentation 含 "Read" 且不含 "js"；tool_call 路由到 executeNestedTool 且参数透传
})
```

- [ ] **Step 2: 确认失败** — `bun test apps/sidecar/src/services/agent-runtime/tools/node-repl/create-node-repl-tools.test.ts`
- [ ] **Step 3: 实现**（js 工具 call 内组装 toolRequest 传入 registry.exec options；instructions 末尾追加：`Agent tools: await tools.NAME(params) (or await tools.call("NAME", params)) invokes the agent's own tools with normal permission checks; await tools.documentation() lists them.`）
- [ ] **Step 4: 全量回归** — `bun test apps/sidecar/src/services/agent-runtime/tools/node-repl/ packages/sdk` + `bunx tsc --noEmit -p apps/sidecar`（按仓库既有 typecheck 入口，若 sidecar 无独立 tsconfig 则跑根 typecheck）
- [ ] **Step 5: 提交**

```bash
rtk git add apps/sidecar/src/services/agent-runtime/tools/node-repl/
rtk git commit -m "✨ feat(sidecar): wire js tool to agent tool bridge with catalog documentation"
```

---

## 完成标准

- node-repl 目录全部测试 + `bun test packages/sdk` 全绿；typecheck clean
- e2e 证明：js 工具执行期，沙箱侧 tool_call 经 executeNestedTool（完整权限管道）、tool_list 返回含 documentation 的目录（排除 js）
- worker.js 改动仅 marshal（无业务逻辑），语法检查通过
- PR 描述注明：stacked on PR#87；无 Rust 改动（通用透传）；保留字与 js 排除规则；沙箱 worker.js 无单测基建的风险声明（由宿主侧 contract/e2e 覆盖协议两端）

## Follow-ups（不在本计划）

- 真沙箱端到端（Electron 内 worker.js 实跑）随手工验收
- dsh 式 code-only 呈现模式（YAGNI，模型自选 both 已够）
- legacy ToolSearchTool 出 deferred 池（P1/P2 遗留项）
