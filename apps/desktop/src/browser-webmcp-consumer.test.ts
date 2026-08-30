// Task 83 TDD：Web MCP 消费端 contextIsolation 修复 + main 转发 page-event。
//
// 覆盖三块：
// 1. listWebMcpTools / invokeWebMcpTool 的 executeJavaScript 脚本在 contextIsolation:true
//    下必须优先读 window.__lumeWebMcpModelContext（contextBridge 暴露的 main-world 句柄），
//    否则 guest-preload 注入的 isolated-world document.modelContext 对消费端 inert。
// 2. handleBrowserPageEvent：webmcp_changed 载荷 → emit browser:webmcp-changed。
// 3. 消费端脚本通过 eval 在 happy-dom 全局上下文中执行，验证 fallback 链真实解析。
//
// 注：不实例化 BrowserRuntime（构造副作用重）；只导入模块级 standalone 函数，
// 以最小 fake tab（webContents.executeJavaScript）驱动。
import { describe, expect, mock, test, beforeEach, afterEach } from 'bun:test'
import { Window } from 'happy-dom'
import { electronMockStub } from '../scripts/test-electron-mock'

await mock.module('electron', () => electronMockStub)

const { listWebMcpTools, invokeWebMcpTool } = await import('./browser-runtime')

// BrowserTab 是非导出类型；函数仅读 tab.generation + tab.webContents.executeJavaScript，
// 以结构化 fake + cast 满足。
type FakeTab = { generation: number; webContents: { executeJavaScript: (script: string, userGesture?: boolean) => Promise<unknown>; isDestroyed: () => boolean } }

function fakeTab(executeJavaScript: (script: string, userGesture?: boolean) => Promise<unknown>): FakeTab {
  return { generation: 1, webContents: { executeJavaScript, isDestroyed: () => false } }
}

// 间接 eval：在 happy-dom 全局上下文（window/document/navigator）中执行 guest 脚本，
// 真实模拟 page-world 对 modelContext 的解析。
async function evalScript<T>(script: string): Promise<T> {
  return await (0, eval)(script) as T
}

// Task 82 的 qe() 在共享 happy-dom Window 上用
//   Object.defineProperty(document/navigator, 'modelContext', {configurable:false, writable:false})
// 永久锁定 document/navigator.modelContext。bunfig.toml 的 preload（test-dom-preload.ts）使
// 所有测试文件共享同一 happy-dom Window（globalThis.window/document/navigator）。一旦
// browser-guest-preload.webmcp.test.ts（字母序 g < w，先执行）首次 enabled=true 调 qe()，
// document/navigator.modelContext 即被锁定为不可配置，本文件此前 beforeEach 里
// `delete document.modelContext` 会抛 TypeError（Unable to delete property）→ 全部 9 用例失败。
//
// 彻底隔离方案：每个用例创建独立 fresh Window，临时覆盖 globalThis 上的
// window/document/navigator，使间接 eval (0, eval)(script) 解析到未污染实例（fresh document
// 上无 modelContext，可自由赋值/读取）。afterEach 还原全局，避免影响后续测试文件。
let savedWindow: unknown
let savedDocument: unknown
let savedNavigator: unknown

beforeEach(() => {
  savedWindow = (globalThis as Record<string, unknown>).window
  savedDocument = (globalThis as Record<string, unknown>).document
  savedNavigator = (globalThis as Record<string, unknown>).navigator
  const fresh = new Window()
  ;(globalThis as Record<string, unknown>).window = fresh
  ;(globalThis as Record<string, unknown>).document = fresh.document
  ;(globalThis as Record<string, unknown>).navigator = fresh.navigator
})

afterEach(() => {
  ;(globalThis as Record<string, unknown>).window = savedWindow
  ;(globalThis as Record<string, unknown>).document = savedDocument
  ;(globalThis as Record<string, unknown>).navigator = savedNavigator
})

describe('listWebMcpTools contextIsolation fallback', () => {
  test('优先读 window.__lumeWebMcpModelContext（contextBridge 暴露的 main-world 句柄）', async () => {
    ;(window as unknown as Record<string, unknown>).__lumeWebMcpModelContext = {
      getTools: () => [
        { name: 'shim-tool', title: 'Shim', description: 'from window shim', inputSchema: null, annotations: null, origin: 'https://x.test', pageUrl: 'https://x.test' },
      ],
    }
    const execute = mock(async (script: string) => evalScript(script))
    const { tools } = await listWebMcpTools(fakeTab(execute) as Parameters<typeof listWebMcpTools>[0])
    expect(tools.length).toBe(1)
    expect(tools[0]?.name).toBe('shim-tool')
    expect(execute).toHaveBeenCalledTimes(1)
  })

  test('window 句柄缺失时回退到 document.modelContext', async () => {
    ;(document as unknown as Record<string, unknown>).modelContext = {
      getTools: () => [{ name: 'doc-tool', description: 'from document' }],
    }
    const execute = mock(async (script: string) => evalScript(script))
    const { tools } = await listWebMcpTools(fakeTab(execute) as Parameters<typeof listWebMcpTools>[0])
    expect(tools[0]?.name).toBe('doc-tool')
  })

  test('所有句柄缺失时返回空数组（不抛错）', async () => {
    const execute = mock(async (script: string) => evalScript(script))
    const { tools } = await listWebMcpTools(fakeTab(execute) as Parameters<typeof listWebMcpTools>[0])
    expect(tools).toEqual([])
  })
})

describe('invokeWebMcpTool contextIsolation fallback', () => {
  test('优先读 window.__lumeWebMcpModelContext.executeTool', async () => {
    let captured: { tool?: unknown; input?: unknown } = {}
    ;(window as unknown as Record<string, unknown>).__lumeWebMcpModelContext = {
      getTools: () => [{ name: 'echo', inputSchema: null, origin: 'https://x.test' }],
      executeTool: async (tool: unknown, input: unknown) => {
        captured = { tool, input }
        return JSON.stringify({ ok: true, input })
      },
    }
    const execute = mock(async (script: string) => evalScript(script))
    const { result } = await invokeWebMcpTool(
      fakeTab(execute) as Parameters<typeof invokeWebMcpTool>[0],
      { toolName: 'echo', input: { hello: 'world' } },
    )
    expect(result).toEqual({ ok: true, input: JSON.stringify({ hello: 'world' }) })
    expect(captured.tool).toEqual({ name: 'echo' })
  })

  test('window 句柄缺失时回退到 document.modelContext.executeTool', async () => {
    ;(document as unknown as Record<string, unknown>).modelContext = {
      getTools: () => [{ name: 'doc-echo' }],
      executeTool: async () => JSON.stringify({ via: 'document' }),
    }
    const execute = mock(async (script: string) => evalScript(script))
    const { result } = await invokeWebMcpTool(
      fakeTab(execute) as Parameters<typeof invokeWebMcpTool>[0],
      { toolName: 'doc-echo' },
    )
    expect(result).toEqual({ via: 'document' })
  })
})

