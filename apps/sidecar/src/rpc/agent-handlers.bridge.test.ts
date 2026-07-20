import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENT_IPC_CHANNELS, PLUGIN_PACKAGE_PRIVILEGED_IPC_CHANNELS } from '@lume/shared'
import type { PlanModePhaseTracker } from '../services/agent/plan-mode-phase-tracker'
import { createAgentHandlers } from './agent-handlers'

// 注：brief 给的测试仅重定向 HOME；但 Windows 上 os.homedir() 读 USERPROFILE 而非 HOME。
// 同时设置两者以保证跨平台一致。
const previousHome = process.env.HOME
const previousUserProfile = process.env.USERPROFILE

function setHome(home: string) {
  process.env.HOME = home
  process.env.USERPROFILE = home
}

function makeHandlers() {
  return createAgentHandlers({
    writeNotification: () => {},
    planModePhaseTracker: {
      isLikelyExecutionRequest: () => false,
      getPhase: () => 'idle',
      clearSession: () => undefined,
    } as unknown as PlanModePhaseTracker,
    notifyPlanModePhaseChange: () => undefined,
  })
}

describe('agent handlers plugin bridge', () => {
  afterEach(() => {
    if (process.env.HOME && process.env.HOME.startsWith(tmpdir())) {
      rmSync(process.env.HOME, { recursive: true, force: true })
    }
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    if (previousUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = previousUserProfile
  })

  test('CHECK_BRIDGE_STATUS 拒绝非本地地址', async () => {
    setHome(mkdtempSync(join(tmpdir(), 'lume-bridge-rpc-')))
    const handlers = makeHandlers()
    await expect(
      handlers[AGENT_IPC_CHANNELS.CHECK_BRIDGE_STATUS]!({
        pluginId: 'demo',
        version: '1.0.0',
        verify: { method: 'tcp-port', detail: '8.8.8.8:53' },
      }),
    ).rejects.toThrow(/本地地址/)
  })

  test('配套包准备接口拒绝无效主进程凭证', async () => {
    setHome(mkdtempSync(join(tmpdir(), 'lume-package-rpc-')))
    const handlers = makeHandlers()
    await expect(handlers[PLUGIN_PACKAGE_PRIVILEGED_IPC_CHANNELS.PREPARE]!({
      credential: 'renderer-controlled',
      request: {
        workspaceSlug: 'default',
        catalogItemKey: 'opaque-catalog-key',
        setupStepId: 'save-package',
        ownerWebContentsId: 7,
        ownerGeneration: 1,
      },
    })).rejects.toThrow(/PRIVILEGED/)
  })
})
