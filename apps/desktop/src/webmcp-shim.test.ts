import { describe, expect, test } from 'bun:test'
import { createWebMcpShim } from './webmcp-shim'

describe('createWebMcpShim (g 工厂)', () => {
  test('registerTool + getTools 返回工具（含 origin/pageUrl）', () => {
    const shim = createWebMcpShim({ locationLike: { origin: 'https://x.com', href: 'https://x.com/p' }, onToolsChanged: () => {} })
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
    // execute 拿到的是 JSON.parse 后的输入对象；返回值会被 shim JSON.stringify
    shim.registerTool({ name: 'add', execute: async (input) => ({ sum: (input as { a: number; b: number }).a + (input as { a: number; b: number }).b }) })
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
    // 正确 registrationId 执行 OK（execute 返回 'r'，shim JSON.stringify 成 '"r"'）
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
