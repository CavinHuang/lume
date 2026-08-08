# 浏览器注释 Web MCP 注入侧 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement task-by-task. Steps use checkbox (`- [ ]`).
> **依据**：Codex `comment-preload.js` qe()/g() 完整实证（D:/temp/codex-asar/extracted/.vite/build/comment-preload.js）+ spec §4.3/附录 A.8。

**Goal:** 补 Web MCP 注入侧——在 `browser-guest-preload.ts` 注入 `__lumeWebMcpModelContext` shim（对齐 Codex qe()/g()），让第三方网页通过 `document.modelContext.registerTool({name, inputSchema, execute})` 注册 MCP 工具，经现有消费侧（`webmcp:list`/`webmcp:invoke`，已 100% 同构）喂给 agent。修复 iab 后端 webmcp 能力过滤（broker）。

**Architecture:** 注入 shim 在 `browser-guest-preload.ts`（生产 preload，main.ts:1124 注入第三方网页——**首个生产功能 plan，非休眠**）。shim 是 additive（contextBridge 暴露 + document.modelContext 定义），不破坏现有 guest-preload 注释 overlay。消费侧（listWebMcpTools/invokeWebMcpTool 读 document.modelContext）已就位，无需改。modelContext 方向：收集网页工具供 agent（与 Codex 同，第三方 URL）。

**Tech Stack:** TypeScript、bun:test + happy-dom。

## Global Constraints

1. **按 Codex qe()/g() 实证**（comment-preload.js 完整代码，调查报告 4b/4c）：g() 工厂（registerTool/unregisterTool/getTools/executeTool/codexGetTools/codexExecuteTool + registrationId staleness + AbortSignal + JSON 字符串 IO + requestUserInteraction throw）；qe() 入口（主进程开关 sendSync + contextBridge 暴露 + document/navigator.modelContext 定义 + onToolsChanged IPC + DOM 加载前注入）。
2. **首个生产功能（非休眠）**：注入 `browser-guest-preload.ts`（main.ts:1124 在线运行）。shim **additive**——不破坏现有 guest-preload 注释 overlay（GuestAnnotationRuntime）。第三方网页将首次可见 `document.modelContext`（可注册工具）。
3. **注入点 browser-guest-preload.ts**（技术必需：消费侧 listWebMcpTools 在 guest-preload 注入的 webContents 执行；overlay-preload 休眠注入无效）。spec §4.3 写 overlay-preload 是基于 Plan 2 假设，实际 overlay 未挂载。
4. **消费侧同构无需改**：listWebMcpTools/invokeWebMcpTool（browser-runtime.ts:3582-3635）+ broker 映射（webmcp_list_tools→webmcp:list）+ capability webmcp + action policy（invoke=authorize）全到位。
5. **modelContext 方向**：收集网页工具供 agent（网页→agent，第三方 URL，与 Codex 同）。
6. 仓库用 **bun**；测试 **bun:test + happy-dom**；**React 18.3.1**（guest-preload 非 React，纯 TS）；共享 `test-electron-mock.ts`。
7. **无 commit 工作流**；**中文注释**；**LF**；测试教训（fiber-key/dispatch 连入 document/renderHook unmount）。
8. **contextBridge 暴露键**：`__lumeWebMcpModelContext`（对齐 Codex `__codexWebMcpModelContext`）。
9. **IPC**：onToolsChanged → `ipcRenderer.send('lume:browser-page-event', {type:'webmcp_changed', version:1})`（新通道，对齐 Codex Be）。主进程开关 → `ipcRenderer.sendSync('lume:get-browser-webmcp-enabled')`（新 sync IPC）。

---

## File Structure

| 文件 | 职责 | 状态 |
|---|---|---|
| `apps/desktop/src/webmcp-shim.ts` | g() 工厂纯函数（registerTool/getTools/executeTool 等 + registrationId + AbortSignal） | **新建** |
| `apps/desktop/src/webmcp-shim.test.ts` | g() TDD | **新建** |
| `apps/desktop/src/browser-guest-preload.ts` | qe() 注入（contextBridge + document.modelContext + onToolsChanged + 开关） | **改** |
| `apps/sidecar/src/services/browser/browser-broker.ts` | iab 后端 webmcp 能力修复（L40 剥离） | **改** |
| `apps/desktop/src/main.ts` | webmcp_changed 事件监听 + get-browser-webmcp-enabled sync IPC（若需） | **改** |
| `apps/desktop/scripts/browser-runtime.e2e.mjs` | e2e fixture 改用 __lumeWebMcpModelContext.registerTool | **改** |

---

## Task 81: webmcp shim g() 工厂

**目标**：纯函数 `createWebMcpShim({locationLike, onToolsChanged})` 移植 Codex g()（comment-preload.js）：registerTool/unregisterTool/getTools/executeTool/codexGetTools/codexExecuteTool + registrationId（uuid staleness）+ AbortSignal 自动注销 + JSON 字符串 IO + requestUserInteraction throw。

**Files:**
- Create: `apps/desktop/src/webmcp-shim.ts`
- Create: `apps/desktop/src/webmcp-shim.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, test, expect } from 'bun:test'
import { createWebMcpShim } from './webmcp-shim'

describe('createWebMcpShim (g 工厂)', () => {
  test('registerTool + getTools 返回工具（含 origin/pageUrl）', () => {
    const changed = () => {}
    const shim = createWebMcpShim({ locationLike: { origin: 'https://x.com', href: 'https://x.com/p' }, onToolsChanged: changed })
    shim.registerTool({ name: 'search', execute: async () => 'ok', description: 'Search', inputSchema: { type: 'object' } })
    const tools = shim.getTools()
    expect(tools.length).toBe(1)
    expect(tools[0]).toMatchObject({ name: 'search', description: 'Search', origin: 'https://x.com', pageUrl: 'https://x.com/p' })
  })
  test('registerTool 触发 onToolsChanged', () => {
    let called = 0
    const shim = createWebMcpShim({ locationLike: { origin: '', href: '' }, onToolsChanged: () => { called++ } })
    shim.registerTool({ name: 't', execute: async () => null })
    expect(called).toBe(1)
  })
  test('unregisterTool 移除 + 触发 onToolsChanged', () => {
    let called = 0
    const shim = createWebMcpShim({ locationLike: { origin: '', href: '' }, onToolsChanged: () => { called++ } })
    shim.registerTool({ name: 't', execute: async () => null })
    called = 0
    expect(shim.unregisterTool('t')).toBe(true)
    expect(shim.getTools().length).toBe(0)
    expect(called).toBe(1)
  })
  test('executeTool(tool, jsonString) 调 execute + JSON IO', async () => {
    const shim = createWebMcpShim({ locationLike: { origin: '', href: '' }, onToolsChanged: () => {} })
    shim.registerTool({ name: 'add', execute: async (input) => JSON.stringify({ sum: input.a + input.b }) })
    const result = await shim.executeTool({ name: 'add' }, JSON.stringify({ a: 1, b: 2 }))
    expect(JSON.parse(result)).toEqual({ sum: 3 })
  })
  test('executeTool 工具不存在抛错', async () => {
    const shim = createWebMcpShim({ locationLike: { origin: '', href: '' }, onToolsChanged: () => {} })
    await expect(shim.executeTool({ name: 'missing' }, '{}')).rejects.toThrow(/not found/)
  })
  test('codexGetTools 含 registrationId；codexExecuteTool stale 校验', async () => {
    const shim = createWebMcpShim({ locationLike: { origin: '', href: '' }, onToolsChanged: () => {} })
    shim.registerTool({ name: 't', execute: async () => 'r' })
    const tools = shim.codexGetTools()
    expect(tools[0].registrationId).toBeTruthy()
    // 正确 registrationId 执行 OK
    await expect(shim.codexExecuteTool(tools[0], '{}')).resolves.toBe('"r"')
    // 错误 registrationId 抛 stale
    await expect(shim.codexExecuteTool({ name: 't', registrationId: 'wrong' }, '{}')).rejects.toThrow(/stale/)
  })
  test('AbortSignal 注销', () => {
    const ac = new AbortController()
    const shim = createWebMcpShim({ locationLike: { origin: '', href: '' }, onToolsChanged: () => {} })
    shim.registerTool({ name: 't', execute: async () => null }, { signal: ac.signal })
    expect(shim.getTools().length).toBe(1)
    ac.abort()
    expect(shim.getTools().length).toBe(0)
  })
  test('registerTool 空 name 抛错', () => {
    const shim = createWebMcpShim({ locationLike: { origin: '', href: '' }, onToolsChanged: () => {} })
    expect(() => shim.registerTool({ name: '', execute: async () => null })).toThrow(/non-empty name/)
    expect(() => shim.registerTool({ name: '  ', execute: async () => null })).toThrow(/non-empty name/)
  })
  test('Object.freeze（不可变）', () => {
    const shim = createWebMcpShim({ locationLike: { origin: '', href: '' }, onToolsChanged: () => {} })
    expect(Object.isFrozen(shim)).toBe(true)
  })
})
```

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现 createWebMcpShim**

移植 Codex g()（调查 4c）。纯 TS，无 electron/DOM 依赖（locationLike 注入）。crypto.randomUUID 替代 Codex getRandomValues（Node/浏览器都有）。AbortSignal addEventListener。JSON.parse/stringify IO。requestUserInteraction throw。

- [ ] **Step 4: 运行通过 + verify typecheck**

Run: `cd apps/desktop && bun test src/webmcp-shim.test.ts` → PASS
Run: `cd apps/desktop && bunx tsc --noEmit -p tsconfig.json` → 无新增

---

## Task 82: guest-preload qe() 注入

**目标**：在 browser-guest-preload.ts 加 qe() 注入——主进程开关（sendSync lume:get-browser-webmcp-enabled）→ createWebMcpShim → contextBridge 暴露 __lumeWebMcpModelContext + document/navigator.modelContext 定义（internalContextBridge.overrideGlobalPropertyFromIsolatedWorld 优先，exposeInMainWorld + defineProperty 回退）→ onToolsChanged → ipcRenderer.send('lume:browser-page-event', {type:'webmcp_changed',version:1})。DOM 加载前注入。

**Files:**
- Modify: `apps/desktop/src/browser-guest-preload.ts`
- Test: `browser-guest-preload.webmcp.test.ts`（新建，mock contextBridge/ipcRenderer）

- [ ] **Step 1: 写失败测试**

测 qe() 注入：开关 true → createWebMcpShim + contextBridge.exposeInMainWorld（或 override）+ document.modelContext 定义 + onToolsChanged 发 webmcp_changed。开关 false → 不注入。

- [ ] **Step 2: 实现 qe()**

移植 Codex qe()（调查 4b）。适配 Lume：
- 开关：`ipcRenderer.sendSync('lume:get-browser-webmcp-enabled')`（新 sync IPC，主进程 Task 83 处理）
- shim：createWebMcpShim({locationLike: location, onToolsChanged: () => ipcRenderer.send('lume:browser-page-event', {type:'webmcp_changed', version:1})})
- 暴露：contextBridge.exposeInMainWorld('__lumeWebMcpModelContext', shim) + document/navigator.modelContext 定义（defineProperty configurable:false enumerable:false writable:false）
- DOM 加载前调用 qe()（guest-preload 模块加载期）

> 注：guest-preload 不用 contextBridge（直接 ipcRenderer）。但注入 modelContext 需要 contextBridge（在页面 main world 暴露对象）。guest-preload 当前 contextIsolation:true（main.ts:1124），contextBridge 可用。

- [ ] **Step 3: 测试通过 + verify**

---

## Task 83: iab 能力修复 + webmcp_changed 主进程

**目标**：(1) broker L40 iab 后端不再剥离 webmcp 能力（让 agent 看到 iab tab webmcp）。(2) main.ts 加 webmcp_changed 事件监听（lume:browser-page-event）+ get-browser-webmcp-enabled sync IPC。

**Files:**
- Modify: `apps/sidecar/src/services/browser/browser-broker.ts:40`（删 webmcp 剥离）
- Modify: `apps/desktop/src/main.ts`（webmcp_changed 监听 + get-browser-webmcp-enabled sync IPC）
- Test: broker + main 相关

- [ ] **Step 1: broker iab 能力修复**

broker L40 `["advancedCdp","browserAuth","pageAssets","webmcp"]` → 删 webmcp（iab 后端保留 webmcp 能力）。

- [ ] **Step 2: main.ts webmcp_changed + 开关**

main.ts 加：
- `ipcMain.on('lume:browser-page-event', ...)` 监听 webmcp_changed（转发给 agent/browser-runtime，让其知道刷新 webmcp:list）
- `ipcMain.on('lume:get-browser-webmcp-enabled-sync', (e) => e.returnValue = true)`（或读 settings，简化默认 true——capability webmcp 已控）

- [ ] **Step 3: 测试 + verify**

---

## Task 84: e2e 测试扩展

**目标**：browser-runtime.e2e.mjs fixture 改用 __lumeWebMcpModelContext.registerTool 注册工具（替代硬编码 document.modelContext），验证注入侧 → 消费侧端到端（webmcp:list/invoke）。

**Files:**
- Modify: `apps/desktop/scripts/browser-runtime.e2e.mjs`

- [ ] **Step 1: fixture 改 registerTool**

fixture HTML（L119-131）改为 `<script>window.__lumeWebMcpModelContext.registerTool({name:'echo',execute:async(i)=>JSON.stringify(i),description:'Echo',inputSchema:{type:'object'}})</script>`（依赖 guest-preload 注入 __lumeWebMcpModelContext）。

> 注：e2e 需真 guest-preload（含 qe() 注入）。若 e2e 不跑 guest-preload（直接 fixture），需确认 e2e harness。

- [ ] **Step 2: 验证 e2e webmcp:list/invoke 通过 registerTool 路径**

---

## Task 85: 整合验证

- [ ] 全量 typecheck + build + test + 生产影响确认（guest-preload 注入 additive 不破坏现有 + iab 能力 + 第三方网页可见 document.modelContext）
- [ ] e2e（若可跑）

---

## 完成判据（Plan 6 收尾）

1. webmcp shim g()（registerTool/getTools/executeTool/codexGetTools/codexExecuteTool + registrationId + AbortSignal）。
2. guest-preload qe() 注入（contextBridge __lumeWebMcpModelContext + document.modelContext + onToolsChanged webmcp_changed + 开关）。
3. iab 能力修复（broker 保留 webmcp）+ main webmcp_changed/开关。
4. e2e registerTool 端到端。
5. **首个生产功能**：第三方网页可见 document.modelContext（additive，不破坏 guest-preload）。
6. typecheck/build/test 绿。
7. 无 commit；ledger 更新。

## Self-Review

**1. Spec 覆盖**（spec §4.3 + A.8）：g() shim Task 81 ✓；qe() 注入 Task 82 ✓；iab 修复 Task 83 ✓；e2e Task 84 ✓。
**2. 占位符**：Task 82 contextBridge override vs exposeInMainWorld 回退（guest-preload contextIsolation）标注实施确认；Task 84 e2e harness 标注。
**3. 生产影响**：首个非休眠 plan（guest-preload 在线）。注入 additive（不破坏现有）。第三方网页可见 document.modelContext。
**4. 消费侧同构**：listWebMcpTools/invokeWebMcpTool 无需改（与 shim 接口匹配）。
