// Task 83：main.ts Web MCP IPC 接线契约守卫。
//
// main.ts 顶层在 app.whenReady 后注册大量 ipcMain handler，模块加载即启动 Electron app，
// 无法在 bun:test 中导入。改用源码级断言锁定 guest-preload qe() 依赖的接线契约：
//
// 1. lume:browser-page-event 必须以 ipcMain.on 注册（guest-preload 用 ipcRenderer.send，
//    非_invoke），并把 payload 交给 browserRuntime.handlePageEvent。
// 2. lume:get-browser-webmcp-enabled 必须以 ipcMain.on 注册（guest-preload 用 sendSync），
//    且 event.returnValue = true（默认开启；未注册时 sendSync 返回 undefined → qe() 视为关闭）。
//
// 这两个契约是 guest-preload 与主进程的硬连线协议，任何一方改名/改通道类型都会破坏
// Web MCP 注入。守卫用精确正则锁定，避免无声回归。
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const mainSource = readFileSync(resolve(here, 'main.ts'), 'utf8')

describe('main.ts Web MCP IPC 接线', () => {
  test("注册 'lume:browser-page-event' 为 ipcMain.on（同步消息通道）", () => {
    // guest-preload qe() 用 ipcRenderer.send → 主进程必须 ipcMain.on（非 handle）
    expect(mainSource).toMatch(/ipcMain\.on\(['"]lume:browser-page-event['"]/)
    // handler 必须把 payload 交给 browserRuntime.handlePageEvent
    expect(mainSource).toMatch(/browserRuntime\?\.handlePageEvent\(/)
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
