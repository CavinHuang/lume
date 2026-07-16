import { beforeEach, describe, expect, mock, test } from 'bun:test'

const installMock = mock(async () => undefined)
const relaunchMock = mock(async () => undefined)

mock.module('@/lib/desktop-runtime/core', () => ({
  convertFileSrc: (path: string) => path,
  invoke: mock(async () => undefined),
  isDesktopRuntime: () => true,
}))

mock.module('@/lib/desktop-runtime/process', () => ({
  relaunch: relaunchMock,
}))

mock.module('@/lib/desktop-runtime/updater', () => ({
  check: mock(async () => ({
    currentVersion: '1.0.0',
    version: '1.1.0',
    download: async () => undefined,
    install: installMock,
  })),
}))

const nativeApi = await import('./native')

describe('desktop update installation', () => {
  beforeEach(() => {
    installMock.mockClear()
    relaunchMock.mockClear()
  })

  test('lets the updater relaunch after installation without starting the old app', async () => {
    await nativeApi.checkDesktopUpdate()
    await nativeApi.installDesktopUpdateAndRelaunch()

    expect(installMock).toHaveBeenCalledTimes(1)
    expect(relaunchMock).not.toHaveBeenCalled()
  })
})
