import { describe, expect, test } from 'bun:test'
import { syncPermissionModeWithPlanPhase } from './agent-input-state'

describe('syncPermissionModeWithPlanPhase', () => {
  test('auto-selects plan while the thread is planning', () => {
    expect(syncPermissionModeWithPlanPhase({
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
    expect(syncPermissionModeWithPlanPhase({
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
    expect(syncPermissionModeWithPlanPhase({
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
