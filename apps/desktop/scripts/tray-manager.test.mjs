import { expect, mock, test } from 'bun:test'

// bun:test 默认共享模式下 mock.module 首写胜出，所有测试必须注册同一 superset stub。
// 共享 stub（./test-electron-mock.ts）的 Tray 在构造时记入 latestTray.current，destroy
// 在 throwOnDestroy 置位时抛 'native destroy failed'；nativeImage.createFromPath 返回
// 非空 image 以满足 buildTrayIcon 的 isEmpty 校验。
import { electronMockStub, latestTray } from './test-electron-mock.ts'
mock.module('electron', () => electronMockStub)

const trayManager = await import('../src/tray-manager.ts')

test('destroyTray marks the tray unavailable even when native destruction throws', () => {
  trayManager.createTray({
    iconPath: 'icon.ico',
    onClickShow: () => {},
    onAction: () => {},
  })
  expect(trayManager.isTrayAvailable()).toBe(true)
  latestTray.current.throwOnDestroy = true
  expect(() => trayManager.destroyTray()).toThrow('native destroy failed')
  expect(trayManager.isTrayAvailable()).toBe(false)
})
