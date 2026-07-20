import { expect, mock, test } from 'bun:test'

let latestTray = null
class FakeTray {
  throwOnDestroy = false
  constructor() {
    latestTray = this
  }
  setToolTip() {}
  on() {}
  setContextMenu() {}
  destroy() {
    if (this.throwOnDestroy) throw new Error('native destroy failed')
  }
}

const fakeImage = {
  isEmpty: () => false,
  resize: () => fakeImage,
  setTemplateImage: () => {},
}

mock.module('electron', () => ({
  Tray: FakeTray,
  Menu: { buildFromTemplate: (template) => template },
  nativeImage: { createFromPath: () => fakeImage },
}))

const trayManager = await import('../src/tray-manager.ts')

test('destroyTray marks the tray unavailable even when native destruction throws', () => {
  trayManager.createTray({
    iconPath: 'icon.ico',
    onClickShow: () => {},
    onAction: () => {},
  })
  expect(trayManager.isTrayAvailable()).toBe(true)
  latestTray.throwOnDestroy = true
  expect(() => trayManager.destroyTray()).toThrow('native destroy failed')
  expect(trayManager.isTrayAvailable()).toBe(false)
})
