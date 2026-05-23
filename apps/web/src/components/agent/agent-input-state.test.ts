import { describe, expect, test } from 'bun:test'
import { shouldSendAgentInputOnEnter, syncPermissionModeWithPlanModePhase } from './agent-input-state'

describe('syncPermissionModeWithPlanModePhase', () => {
  test('auto-selects plan while the thread is planning', () => {
    expect(syncPermissionModeWithPlanModePhase({
      permissionMode: 'default',
      defaultPermissionMode: 'default',
      planPhase: 'planning',
      autoSelectedPlan: false,
    })).toEqual({
      permissionMode: 'plan',
      autoSelectedPlan: true,
    })
  })

  test('auto-selects plan while the thread is awaiting approval', () => {
    expect(syncPermissionModeWithPlanModePhase({
      permissionMode: 'default',
      defaultPermissionMode: 'default',
      planPhase: 'awaiting_approval',
      autoSelectedPlan: false,
    })).toEqual({
      permissionMode: 'plan',
      autoSelectedPlan: true,
    })
  })

  test('restores the default mode after an automatic plan selection starts executing', () => {
    expect(syncPermissionModeWithPlanModePhase({
      permissionMode: 'plan',
      defaultPermissionMode: 'acceptEdits',
      planPhase: 'executing',
      autoSelectedPlan: true,
    })).toEqual({
      permissionMode: 'acceptEdits',
      autoSelectedPlan: false,
    })
  })

  test('keeps a manually selected plan mode after the plan phase ends', () => {
    expect(syncPermissionModeWithPlanModePhase({
      permissionMode: 'plan',
      defaultPermissionMode: 'default',
      planPhase: 'completed',
      autoSelectedPlan: false,
    })).toEqual({
      permissionMode: 'plan',
      autoSelectedPlan: false,
    })
  })
})

describe('shouldSendAgentInputOnEnter', () => {
  test('does not send while a mention suggestion panel is open', () => {
    expect(shouldSendAgentInputOnEnter({
      key: 'Enter',
      shiftKey: false,
    }, true)).toBe(false)
  })

  test('sends on plain Enter when no mention suggestion is open', () => {
    expect(shouldSendAgentInputOnEnter({
      key: 'Enter',
      shiftKey: false,
    }, false)).toBe(true)
  })

  test('does not send on Shift Enter', () => {
    expect(shouldSendAgentInputOnEnter({
      key: 'Enter',
      shiftKey: true,
    }, false)).toBe(false)
  })
})
