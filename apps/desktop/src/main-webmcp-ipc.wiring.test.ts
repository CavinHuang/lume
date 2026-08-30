// Task 83：main.ts Web MCP IPC 接线契约守卫。
//
// main.ts 顶层在 app.whenReady 后注册大量 ipcMain handler，模块加载即启动 Electron app，
// 无法在 bun:test 中导入。改用源码级断言锁定 guest-preload qe() 依赖的接线契约：
//
// lume:get-browser-webmcp-enabled 必须以 ipcMain.on 注册（guest-preload 用 sendSync），
// 且 event.returnValue = true（默认开启；未注册时 sendSync 返回 undefined → qe() 视为关闭）。
// 该契约是 guest-preload 与主进程的硬连线协议，任何一方改名/改通道类型都会破坏
// Web MCP 注入。守卫用精确正则锁定，避免无声回归。
//
// 历史：lume:browser-page-event 推送通道（webmcp_changed → browser:webmcp-changed 事件）
// 已随死面清理移除——该事件自始无任何消费方，消费侧按需拉取 webmcp:list。
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const mainSource = readFileSync(resolve(here, 'main.ts'), 'utf8')

describe('main.ts Web MCP IPC 接线', () => {
  test('已移除的 page-event 推送通道不再回潮（browser:webmcp-changed 自始无消费方）', () => {
    expect(mainSource).not.toContain('lume:browser-page-event')
  })

  test("注册 'lume:get-browser-webmcp-enabled' 为 ipcMain.on 并 returnValue=true", () => {
    // guest-preload qe() 用 ipcRenderer.sendSync → 主进程必须 ipcMain.on + event.returnValue
    expect(mainSource).toMatch(/ipcMain\.on\(['"]lume:get-browser-webmcp-enabled['"]/)
    // 在该 handler 块内 event.returnValue 置为 true（默认开启）
    const handlerMatch = mainSource.match(/ipcMain\.on\(['"]lume:get-browser-webmcp-enabled['"],\s*\(([^)]*)\)\s*=>\s*\{([^}]*)\}/)
    expect(handlerMatch).not.toBeNull()
    expect(handlerMatch && handlerMatch[2]).toContain('event.returnValue = true')
  })
})
