# P2 按需加载——搜到即转正 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ToolSearch 命中的工具在下一步加入原生 tools 数组，模型直接原生调用；ExecuteTool 降级为兼容兜底。

**Architecture:** `QueryEngine` 构造时把生成的 ToolSearch/ExecuteTool 重绑到 engine 的活动 deferred 列表（解决 agent→engine 数组副本失联）；`ToolContext` 新增 `activateTools` 钩子，ToolSearch 命中后批量晋升（写 `config.tools`、从 `config.deferredTools` 移除），下一轮 `providerRequest.tools`（每轮从 `config.tools` 重建，`engine.ts:1080`）自动携带。先例：skill-scope 激活（`engine.ts:2139-2146`）同款 mutation 模式。

**Tech Stack:** TypeScript、bun:test。复用 `createToolSearchTool`/`createExecuteTool` 工厂（`packages/sdk/src/tools/tool-search.ts`）。

**Spec:** `docs/superpowers/specs/2026-08-14-tool-injection-optimization-design.md`（P2 节）

## Global Constraints

- **Stacked 分支**：基于 `feat/tool-registry`（PR#85，含 P1 registry）开发，worktree 从该分支创建；PR#85 有 review 改动则先 rebase
- prompt cache 取舍已由 spec 批准：批量晋升（一次 ToolSearch 命中的全部工具同轮转正 = 一次 cache miss），不做逐个转正、不做节流（上线后测命中率再定）
- system prompt（`buildSystemPrompt`，engine.ts:934，仅构建一次）与 deferredToolGuide 文本保持静态 —— 转正不触碰 prompt 前缀
- 测试跑 bun:test；提交 emoji 前缀；注释英文
- Engine 对外 SDKMessage 事件格式不变（init.tools 列表仍为初始 tools，属展示层快照，不追转正）

## Ruling（计划内裁定，执行时不再讨论）

- **tst-auto 不搬迁**：spec 说"tst-auto 的 token 预算判断并入 registry 的 split()"——实际现状是 `rebuildToolPool` 已经用 `isToolSearchEnabled`（含 tst-auto 阈值）驱动 core/deferred 全量划分，行为已满足 spec 意图；把工作代码搬进 registry 是纯搬迁。**不搬**，spec 该项视为已满足。若需更强内聚，P3 时随 preset 链扩展一并做。

---

### Task 1: ToolContext.activateTools 钩子 + engine 晋升与重绑

**Files:**
- Modify: `packages/sdk/src/types.ts`（ToolContext 接口）
- Modify: `packages/sdk/src/engine.ts`（QueryEngine 构造重绑 + executeSingleTool 接线）
- Test: `packages/sdk/src/engine.test.ts`（追加）

**Interfaces:**
- Produces:
  ```ts
  // types.ts — ToolContext 追加可选成员
  activateTools?: (names: string[]) => string[]  // 返回实际晋升的工具名（未知名忽略）
  ```
  engine 接线语义（后续任务依赖）：
  - QueryEngine 构造时（`config.deferredTools` 非空才做）：用 `createToolSearchTool(() => this.config.deferredTools ?? [])` 与 `createExecuteTool(() => this.config.deferredTools ?? [])` **替换** `config.tools` 中同名工具（重绑到 engine 活动状态）
  - `activateTools(names)`：把 `config.deferredTools` 中名字匹配的工具 push 进 `config.tools`（去重），并从 `config.deferredTools` 移除；返回实际晋升名列表
  - skill-scope 激活（engine.ts:2139-2146）保持不变，与晋升共存

- [ ] **Step 1: 写失败测试**（engine.test.ts，复用既有 fake provider/工具 fixture 模式）

```ts
test("activateTools promotes deferred tools into the native tools array", async () => {
  const deferred = makeTool("GuanlanSearch")          // 既有 fixture：最小 ToolDefinition
  // 注意：探测工具不可命名为 ToolSearch/ExecuteTool —— 构造期重绑会替换同名工具
  const activator = makeTool("ProbeTool")             // 任意工具转调 context.activateTools 验证钩子
  activator.call = async (_input: any, context: any) => {
    const promoted = context.activateTools?.(["GuanlanSearch", "NoSuchTool"]) ?? []
    return { type: "tool_result", tool_use_id: "", content: JSON.stringify(promoted) }
  }
  const requests: any[] = []
  const provider = makeCapturingProvider(requests)    // 既有模式：记录 createMessage params，先返回 ProbeTool 调用再返回 text
  const engine = new QueryEngine({
    cwd: process.cwd(), model: "host/model-a", provider,
    tools: [activator], deferredTools: [deferred],
    maxTurns: 5, maxTokens: 1000,
  })
  const events = []
  for await (const e of engine.query("go")) events.push(e)

  // 晋升去重且忽略未知名
  const activatorResult = events.find((e) => e.type === "tool_result") // 按既有事件断言模式调整
  expect(JSON.parse(activatorResult.result.content)).toEqual(["GuanlanSearch"])
  // 下一轮请求原生携带晋升工具
  const lastRequest = requests[requests.length - 1]
  expect(lastRequest.tools.map((t: any) => t.name)).toContain("GuanlanSearch")
})
```

（fixture 细节以 engine.test.ts 既有模式为准：ToolUseProvider/CapturingProvider 已有先例，可组合——第一轮返回 ProbeTool 的 tool_use，第二轮返回纯 text 结束。）

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test packages/sdk/src/engine.test.ts`
Expected: FAIL — `context.activateTools` 为 undefined

- [ ] **Step 3: 实现**

types.ts ToolContext 追加：
```ts
/** Promote deferred tools into the native tools array for subsequent turns. Returns names actually promoted. */
activateTools?: (names: string[]) => string[]
```

engine.ts —— QueryEngine 构造（config 初始化处）追加重绑：
```ts
// Rebind generated discovery tools to the engine's live deferred list:
// the agent passes a filtered copy, so promotion must be engine-local.
if (this.config.deferredTools && this.config.deferredTools.length > 0) {
  const live = () => this.config.deferredTools ?? []
  this.config.tools = this.config.tools.map((tool) =>
    tool.name === 'ToolSearch' ? createToolSearchTool(live)
      : tool.name === 'ExecuteTool' ? createExecuteTool(live)
        : tool)
}
```

executeSingleTool 的 toolContext（engine.ts:1642 附近）追加：
```ts
toolContext.activateTools = (names) => {
  const promoted: string[] = []
  for (const name of names) {
    const target = this.config.deferredTools?.find((candidate) => candidate.name === name)
    if (!target || this.config.tools.some((candidate) => candidate.name === name)) continue
    this.config.tools.push(target)
    this.config.deferredTools = this.config.deferredTools?.filter((candidate) => candidate.name !== name) ?? []
    promoted.push(name)
  }
  return promoted
}
```

头部导入 `createToolSearchTool`/`createExecuteTool`（`./tools/tool-search.js`）。

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test packages/sdk/src/engine.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
rtk git add packages/sdk/src/types.ts packages/sdk/src/engine.ts packages/sdk/src/engine.test.ts
rtk git commit -m "✨ feat(sdk): engine-side deferred tool promotion via ToolContext.activateTools"
```

---

### Task 2: ToolSearch 触发晋升 + 直调指引

**Files:**
- Modify: `packages/sdk/src/tools/tool-search.ts`（`createToolSearchTool` 的 call）
- Test: `packages/sdk/src/tools/search-tools.test.ts`（追加，已有该文件）

**Interfaces:**
- Consumes: Task 1 的 `context.activateTools`
- Produces: ToolSearch 结果语义变更（engine.test.ts Task 1 用例 + 本任务单测共同锁定）：
  - 命中后调 `context.activateTools?.(matched names)`，结果文本指引"工具已原生可用，直接按名调用"
  - `activateTools` 缺席（子代理/旧 runtime）时保持旧文案（ExecuteTool 代理调用）—— 兼容兜底
  - dedup 自动成立：getTools 绑定 engine 活动 deferred 列表，晋升后不再出现

- [ ] **Step 1: 写失败测试**（search-tools.test.ts，`createToolSearchTool` 现有单测旁追加）

```ts
test("activates matched tools when the hook is present", async () => {
  const activated: string[][] = []
  const tool = createToolSearchTool(() => [makeFakeTool("GuanlanSearch")])
  const result = await tool.call({ query: "guanlan" }, {
    activateTools: (names) => { activated.push(names); return names },
  } as any)
  expect(activated).toEqual([["GuanlanSearch"]])
  expect(result.content).toContain("call them directly")
})

test("falls back to ExecuteTool guidance without the hook", async () => {
  const tool = createToolSearchTool(() => [makeFakeTool("GuanlanSearch")])
  const result = await tool.call({ query: "guanlan" }, {} as any)
  expect(result.content).toContain("ExecuteTool")
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test packages/sdk/src/tools/search-tools.test.ts`
Expected: FAIL — 未调用 activateTools / 文案不含 "call them directly"

- [ ] **Step 3: 实现**（tool-search.ts createToolSearchTool.call 的返回段替换）

```ts
const matchedNames = matches.map((tool) => tool.name)
const promoted = context?.activateTools?.(matchedNames)
const usage = promoted && promoted.length > 0
  ? 'The matched tools are now available natively — call them directly by name with their documented parameters.'
  : 'Call ExecuteTool with tool_name and params to invoke a selected tool.'
return success(JSON.stringify({
  tools: matches.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema })),
  usage,
}, null, 2))
```

（`call(input, context)` 签名已存在；`select:` 分支同样经过此路径，天然批量晋升。）

- [ ] **Step 4: 全量回归**

Run: `bun test packages/sdk/src/tools/ packages/sdk/src/engine.test.ts packages/sdk/src/agent.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
rtk git add packages/sdk/src/tools/tool-search.ts packages/sdk/src/tools/search-tools.test.ts
rtk git commit -m "✨ feat(sdk): ToolSearch promotes matches to native tools with direct-call guidance"
```

---

### Task 3: engine 指引文案对齐 + 回归收口

**Files:**
- Modify: `packages/sdk/src/engine.ts:279`（deferredToolGuide）
- Test: `packages/sdk/src/engine.test.ts`（断言更新或追加）

**Interfaces:**
- Consumes: Task 1/2 已落地
- Produces: 最终对模型的完整语义链：deferredToolGuide（静态）+ ToolSearch 结果（动态指引）

- [ ] **Step 1: 更新 deferredToolGuide 文案**

```ts
const deferredToolGuide = config.deferredTools?.length
  ? '\n\nSome tools are deferred to keep your context focused. Use ToolSearch to discover them; matched tools become natively callable on your next turn — call them directly by name. Do not claim a capability is unavailable before searching when the visible tools do not cover the task.'
  : ''
```

- [ ] **Step 2: 端到端回归（晋升全链路）**

在 engine.test.ts 追加一条链路用例：deferred 工具 GuanlanSearch + 真 `createToolSearchTool`（engine 构造重绑后即为真身）；fake provider 第一轮返回 `ToolSearch(query="select:GuanlanSearch")` 的 tool_use，第二轮直接返回 `GuanlanSearch` 的 tool_use，第三轮 text 结束。断言：
- 第二轮请求 `tools` 含 GuanlanSearch（原生转正生效）
- GuanlanSearch 的 tool_use 正常执行（走 `config.tools.find`，engine.ts:1549 路径，参数校验/权限照常）
- 第三轮后 `config.deferredTools` 不含 GuanlanSearch

Run: `bun test packages/sdk/src/engine.test.ts`
Expected: PASS

- [ ] **Step 3: 全量回归 + typecheck**

Run: `bun test packages/sdk && bunx tsc --noEmit -p packages/sdk`
Expected: PASS / 无错误

- [ ] **Step 4: 提交**

```bash
rtk git add packages/sdk/src/engine.ts packages/sdk/src/engine.test.ts
rtk git commit -m "✨ feat(sdk): align deferred tool guidance with native promotion semantics"
```

---

## 完成标准

- `bun test packages/sdk` 全绿；`bunx tsc --noEmit -p packages/sdk` 无错
- 端到端链路用例证明：ToolSearch → 下一轮原生调用 → deferred 移除
- ExecuteTool 保留且可用（兼容兜底，子代理路径不受影响）
- PR 描述注明：stacked on PR#85；cache 取舍（批量晋升一次 miss）；tst-auto 不搬迁的 Ruling

## P3 衔接（不在本计划内）

P3 Code Mode 的 `tools.*` API 目录 = registry `visible()` + 已晋升工具；P2 的 activateTools 语义直接映射为 REPL 内 select 后可用。
