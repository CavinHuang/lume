import { describe, expect, test } from 'bun:test'
import {
  getUpdateActionState,
  normalizeReleaseVersion,
  shouldAutoCheckUpdates,
  type VersionUpdateSnapshot,
} from './version-update-state'

describe('version update state', () => {
  test('normalizes release tags before comparing versions', () => {
    expect(normalizeReleaseVersion('v0.1.1')).toBe('0.1.1')
    expect(normalizeReleaseVersion('  0.2.0  ')).toBe('0.2.0')
  })

  test('shows download action only when an update is available and not downloaded', () => {
    const snapshot: VersionUpdateSnapshot = {
      currentVersion: '0.1.0',
      latestVersion: '0.1.1',
      status: 'available',
      downloaded: false,
    }

    expect(getUpdateActionState(snapshot)).toEqual({
      canCheck: true,
      canDownload: true,
      canInstall: false,
      busyLabel: null,
    })
  })

  test('shows install action after an update has downloaded', () => {
    const snapshot: VersionUpdateSnapshot = {
      currentVersion: '0.1.0',
      latestVersion: '0.1.1',
      status: 'downloaded',
      downloaded: true,
    }

    expect(getUpdateActionState(snapshot)).toEqual({
      canCheck: true,
      canDownload: false,
      canInstall: true,
      busyLabel: null,
    })
  })

  test('locks update actions while checking or downloading', () => {
    expect(getUpdateActionState({
      currentVersion: '0.1.0',
      latestVersion: null,
      status: 'checking',
      downloaded: false,
    })).toEqual({
      canCheck: false,
      canDownload: false,
      canInstall: false,
      busyLabel: '检查中...',
    })

    expect(getUpdateActionState({
      currentVersion: '0.1.0',
      latestVersion: '0.1.1',
      status: 'downloading',
      downloaded: false,
    })).toEqual({
      canCheck: false,
      canDownload: false,
      canInstall: false,
      busyLabel: '下载中...',
    })
  })

  test('auto check runs when enabled and the last check is stale', () => {
    const now = new Date('2026-05-05T12:00:00.000Z')

    expect(shouldAutoCheckUpdates(true, null, now)).toBe(true)
    expect(shouldAutoCheckUpdates(false, null, now)).toBe(false)
    expect(shouldAutoCheckUpdates(true, '2026-05-05T01:00:00.000Z', now)).toBe(false)
    expect(shouldAutoCheckUpdates(true, '2026-05-03T01:00:00.000Z', now)).toBe(true)
  })
})
