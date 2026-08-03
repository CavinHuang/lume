import { describe, expect, test } from 'bun:test'
import {
  deriveAgentInputSubmitState,
  shouldReleaseAgentInputLocalSendingAfterDispatch,
  resolveAgentInputConfigWorkspaceSlug,
  shouldSendAgentInputOnEnter,
  syncPermissionModeWithDefaultConfig,
  syncPermissionModeWithPlanModePhase,
} from './agent-input-state'

describe('deriveAgentInputSubmitState', () => {
  test('idle with text sends immediately', () => {
    expect(deriveAgentInputSubmitState({
      hasText: true,
      streaming: false,
      localSending: false,
    })).toEqual({
      action: 'send',
      canSubmit: true,
      label: '发送',
    })
  })

  test('streaming without text stops the current run', () => {
    expect(deriveAgentInputSubmitState({
      hasText: false,
      streaming: true,
      localSending: false,
    })).toEqual({
      action: 'stop',
      canSubmit: true,
      label: '停止',
    })
  })

  test('streaming with text queues the next message', () => {
    expect(deriveAgentInputSubmitState({
      hasText: true,
      streaming: true,
      localSending: false,
    })).toEqual({
      action: 'queue',
      canSubmit: true,
      label: '排队',
    })
  })

  test('local sending is busy', () => {
    expect(deriveAgentInputSubmitState({
      hasText: true,
      streaming: true,
      localSending: true,
    })).toEqual({
      action: 'busy',
      canSubmit: false,
      label: '发送中',
    })
  })
})

describe('shouldReleaseAgentInputLocalSendingAfterDispatch', () => {
  test('releases local sending after an immediate send dispatch returns', () => {
    expect(shouldReleaseAgentInputLocalSendingAfterDispatch('sent')).toBe(true)
  })

  test('releases local sending after a queued dispatch returns', () => {
    expect(shouldReleaseAgentInputLocalSendingAfterDispatch('queued')).toBe(true)
  })
})

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

describe('syncPermissionModeWithDefaultConfig', () => {
  test('updates the composer mode when the thread has no manual permission override', () => {
    expect(syncPermissionModeWithDefaultConfig({
      currentPermissionMode: 'default',
      nextDefaultPermissionMode: 'dontAsk',
      autoSelectedPlan: false,
    })).toEqual({
      permissionMode: 'dontAsk',
      autoSelectedPlan: false,
    })
  })

  test('keeps the manual thread override when default config changes', () => {
    expect(syncPermissionModeWithDefaultConfig({
      currentPermissionMode: 'acceptEdits',
      nextDefaultPermissionMode: 'dontAsk',
      threadPermissionMode: 'acceptEdits',
      autoSelectedPlan: false,
    })).toEqual({
      permissionMode: 'acceptEdits',
      autoSelectedPlan: false,
    })
  })

  test('keeps the thread override while a stale plan phase is active', () => {
    expect(syncPermissionModeWithDefaultConfig({
      currentPermissionMode: 'bypassPermissions',
      nextDefaultPermissionMode: 'default',
      threadPermissionMode: 'bypassPermissions',
      planPhase: 'planning',
      autoSelectedPlan: false,
    })).toEqual({
      permissionMode: 'bypassPermissions',
      autoSelectedPlan: false,
    })
  })
})

describe('resolveAgentInputConfigWorkspaceSlug', () => {
  const workspaces = [
    { id: 'workspace-1', slug: 'alpha' },
    { id: 'workspace-2', slug: 'beta' },
  ]

  test('uses the thread workspace before the current workspace', () => {
    expect(resolveAgentInputConfigWorkspaceSlug({
      threadWorkspaceId: 'workspace-2',
      currentWorkspaceId: 'workspace-1',
      workspaces,
    })).toBe('beta')
  })

  test('falls back to the current workspace for new threads without metadata yet', () => {
    expect(resolveAgentInputConfigWorkspaceSlug({
      threadWorkspaceId: null,
      currentWorkspaceId: 'workspace-1',
      workspaces,
    })).toBe('alpha')
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
