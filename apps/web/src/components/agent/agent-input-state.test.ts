import { describe, expect, test } from 'bun:test'
import { syncPermissionModeWithPlanModePhase } from './agent-input-state'

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

  test('restores the default mode after an automatic plan selection leaves review', () => {
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
      planPhase: 'executed',
      autoSelectedPlan: false,
    })).toEqual({
      permissionMode: 'plan',
      autoSelectedPlan: false,
    })
  })
})
