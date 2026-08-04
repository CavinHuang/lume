// TDD tests for qe() Web MCP 注入（Task 82，移植自 Codex comment-preload.js qe()）。
//
// browser-guest-preload.ts 顶层 import 'electron'；与其它 desktop 测试一致，
// 注册共享 superset stub（mock.module 首写胜出）。本测试通过 stub 新增的可观测字段
// （ipcRendererSentMessages / ipcRendererSendSyncReturns / contextBridgeExposures）
// 验证 qe() 的副作用。
//
// 注：
// - 模块加载时 qe() 已自动调用一次（sendSyncReturns 未配置 → false 分支 → 不注入）。
// - qe() 用 Object.defineProperty(configurable:false) 写 document/navigator.modelContext，
//   首次写入后无法重定义（catch 吞错），故涉及 document.modelContext 引用的断言集中在
//   首个 enabled=true 测试。其余测试仅断言 contextBridgeExposures / sentMessages（每次 qe()
//   都会刷新）。
import { describe, expect, test, mock, beforeEach } from 'bun:test'
import {
  electronMockStub,
  ipcRendererSentMessages,
  ipcRendererSendSyncReturns,
  contextBridgeExposures,
} from '../scripts/test-electron-mock'

await mock.module('electron', () => electronMockStub)

const { qe } = await import('./browser-guest-preload')

// qe() 注入 document/navigator.modelContext（Task 82）；TS 标准 lib 无此属性，扩展类型供断言。
declare global {
  interface Document { modelContext?: unknown }
  interface Navigator { modelContext?: unknown }
}

beforeEach(() => {
  ipcRendererSentMessages.length = 0
  contextBridgeExposures.clear()
  for (const key of Object.keys(ipcRendererSendSyncReturns)) delete ipcRendererSendSyncReturns[key]
})

describe('qe() Web MCP 注入', () => {
  test('开关 true → 注入 shim（exposeInMainWorld + document/navigator.modelContext + 描述符）', () => {
    // 必须是首个 enabled=true 测试：document.modelContext 一旦以 configurable:false 写入
    // 即不可重定义，后续 qe() 调用的 defineProperty 会被 catch 吞掉。
    ipcRendererSendSyncReturns['lume:get-browser-webmcp-enabled'] = true
    qe()

    // 1) contextBridge.exposeInMainWorld 暴露 shim
    expect(contextBridgeExposures.has('__lumeWebMcpModelContext')).toBe(true)
    const shim = contextBridgeExposures.get('__lumeWebMcpModelContext') as Record<string, unknown>
    // 形态对齐 createWebMcpShim（registerTool/getTools/codexGetTools/executeTool/codexExecuteTool/unregisterTool）
    expect(typeof shim.registerTool).toBe('function')
    expect(typeof shim.unregisterTool).toBe('function')
    expect(typeof shim.getTools).toBe('function')
    expect(typeof shim.codexGetTools).toBe('function')
    expect(typeof shim.executeTool).toBe('function')
    expect(typeof shim.codexExecuteTool).toBe('function')
    expect(Object.isFrozen(shim)).toBe(true)

    // 2) document/navigator.modelContext 指向同一 shim
    expect(document.modelContext).toBe(shim)
    expect(navigator.modelContext).toBe(shim)

    // 3) 描述符 configurable/enumerable/writable 均为 false（不可枚举/不可重写/不可重定义）
    const docDesc = Object.getOwnPropertyDescriptor(document, 'modelContext')
    expect(docDesc?.configurable).toBe(false)
    expect(docDesc?.enumerable).toBe(false)
    expect(docDesc?.writable).toBe(false)

    const navDesc = Object.getOwnPropertyDescriptor(navigator, 'modelContext')
    expect(navDesc?.configurable).toBe(false)
    expect(navDesc?.enumerable).toBe(false)
    expect(navDesc?.writable).toBe(false)
  })

  test('开关 true → onToolsChanged 触发 ipcRenderer.send webmcp_changed (version:1)', () => {
    ipcRendererSendSyncReturns['lume:get-browser-webmcp-enabled'] = true
    qe()

    // 取最新 shim（contextBridgeExposures 每次 qe() 都会刷新）
    const shim = contextBridgeExposures.get('__lumeWebMcpModelContext') as {
      registerTool: (tool: unknown) => void
    }
    // 注册工具 → 内部 onToolsChanged → ipcRenderer.send('lume:browser-page-event', ...)
    shim.registerTool({ name: 'demo', execute: async () => null })

    const event = ipcRendererSentMessages.find((m) => m.channel === 'lume:browser-page-event')
    expect(event).toBeDefined()
    expect(event!.args[0]).toEqual({ type: 'webmcp_changed', version: 1 })
  })

  test('开关 true → shim.locationLike 来自当前 location（origin/href）', () => {
    ipcRendererSendSyncReturns['lume:get-browser-webmcp-enabled'] = true
    qe()

    const shim = contextBridgeExposures.get('__lumeWebMcpModelContext') as {
      registerTool: (t: unknown) => void
      getTools: () => Array<{ origin?: string; pageUrl?: string }>
    }
    shim.registerTool({ name: 'probe', execute: async () => null })
    const tools = shim.getTools()
    expect(tools[0]?.origin).toBe(window.location.origin)
    expect(tools[0]?.pageUrl).toBe(window.location.href)
  })

  test('开关 false → 不调用 exposeInMainWorld（无 __lumeWebMcpModelContext 暴露）', () => {
    ipcRendererSendSyncReturns['lume:get-browser-webmcp-enabled'] = false
    qe()

    expect(contextBridgeExposures.has('__lumeWebMcpModelContext')).toBe(false)
  })

  test('开关未配置（sendSync 返回 undefined）→ 同样不注入', () => {
    // ipcRendererSendSyncReturns 未设置，sendSync 默认返回 undefined
    qe()

    expect(contextBridgeExposures.has('__lumeWebMcpModelContext')).toBe(false)
  })
})
