import { describe, expect, test } from 'bun:test'
import { applyVoiceMicPermissionState, type VoiceMicPermissionState } from './desktop-core'

const INITIAL: VoiceMicPermissionState = { sawDeniedInProcess: false, restartRequired: false }

describe('applyVoiceMicPermissionState', () => {
  test('initial denied marks sawDenied but not restartRequired', () => {
    // 首次查询就是 denied：系统侧从未允许过，谈不上“重启生效”。
    expect(applyVoiceMicPermissionState(INITIAL, 'denied')).toEqual({
      sawDeniedInProcess: true,
      restartRequired: false,
    })
  })

  test('denied then granted in the same process requires restart', () => {
    const afterDenied = applyVoiceMicPermissionState(INITIAL, 'denied')
    expect(applyVoiceMicPermissionState(afterDenied, 'granted')).toEqual({
      sawDeniedInProcess: true,
      restartRequired: true,
    })
  })

  test('not-determined granted via prompt never requires restart', () => {
    const afterPrompt = applyVoiceMicPermissionState(INITIAL, 'not-determined')
    expect(applyVoiceMicPermissionState(afterPrompt, 'granted')).toEqual({
      sawDeniedInProcess: false,
      restartRequired: false,
    })
  })

  test('restart-required persists across subsequent checks until process restart', () => {
    let state = applyVoiceMicPermissionState(INITIAL, 'denied')
    state = applyVoiceMicPermissionState(state, 'granted')
    expect(applyVoiceMicPermissionState(state, 'granted').restartRequired).toBe(true)
  })

  test('plain granted from a fresh process stays clean', () => {
    expect(applyVoiceMicPermissionState(INITIAL, 'granted')).toEqual({
      sawDeniedInProcess: false,
      restartRequired: false,
    })
  })
})
