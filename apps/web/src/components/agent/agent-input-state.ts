import type { PlanModePhase } from '@lume/shared'
import type { PermissionModeValue } from '@/components/settings/agent-settings-state'

interface AgentInputConfigWorkspace {
  id: string
  slug: string
}

interface PermissionPlanSyncInput {
  permissionMode: PermissionModeValue
  defaultPermissionMode: PermissionModeValue
  planPhase?: PlanModePhase
  autoSelectedPlan: boolean
}

interface PermissionPlanSyncOutput {
  permissionMode: PermissionModeValue
  autoSelectedPlan: boolean
}

interface PermissionDefaultConfigSyncInput {
  currentPermissionMode: PermissionModeValue
  nextDefaultPermissionMode: PermissionModeValue
  threadPermissionMode?: PermissionModeValue
  planPhase?: PlanModePhase
  autoSelectedPlan: boolean
}

interface AgentInputEnterEvent {
  key: string
  shiftKey: boolean
}

export type AgentInputSubmitAction = 'send' | 'queue' | 'stop' | 'busy' | 'disabled'
export type AgentInputDispatchMode = 'sent' | 'queued'

export interface AgentInputSubmitState {
  action: AgentInputSubmitAction
  canSubmit: boolean
  label: string
}

export function deriveAgentInputSubmitState(input: {
  hasText: boolean
  streaming: boolean
  localSending: boolean
}): AgentInputSubmitState {
  if (input.localSending) {
    return {
      action: 'busy',
      canSubmit: false,
      label: '发送中',
    }
  }
  if (input.streaming) {
    if (input.hasText) {
      return {
        action: 'queue',
        canSubmit: true,
        label: '排队',
      }
    }
    return {
      action: 'stop',
      canSubmit: true,
      label: '停止',
    }
  }
  if (input.hasText) {
    return {
      action: 'send',
      canSubmit: true,
      label: '发送',
    }
  }
  return {
    action: 'disabled',
    canSubmit: false,
    label: '发送',
  }
}

export function shouldReleaseAgentInputLocalSendingAfterDispatch(_mode: AgentInputDispatchMode): boolean {
  return true
}

export function shouldSendAgentInputOnEnter(
  event: AgentInputEnterEvent,
  mentionSuggestionOpen: boolean,
): boolean {
  return event.key === 'Enter'
    && !event.shiftKey
    && !mentionSuggestionOpen
}

export function syncPermissionModeWithPlanModePhase(input: PermissionPlanSyncInput): PermissionPlanSyncOutput {
  const planActive = input.planPhase === 'planning' || input.planPhase === 'awaiting_approval'
  if (planActive) {
    return {
      permissionMode: 'plan',
      autoSelectedPlan: input.permissionMode !== 'plan' || input.autoSelectedPlan,
    }
  }
  if (input.autoSelectedPlan) {
    return {
      permissionMode: input.defaultPermissionMode,
      autoSelectedPlan: false,
    }
  }
  return {
    permissionMode: input.permissionMode,
    autoSelectedPlan: false,
  }
}

export function syncPermissionModeWithDefaultConfig(input: PermissionDefaultConfigSyncInput): PermissionPlanSyncOutput {
  if (input.threadPermissionMode) {
    return {
      permissionMode: input.threadPermissionMode,
      autoSelectedPlan: false,
    }
  }

  const planSynced = syncPermissionModeWithPlanModePhase({
    permissionMode: input.currentPermissionMode,
    defaultPermissionMode: input.nextDefaultPermissionMode,
    planPhase: input.planPhase,
    autoSelectedPlan: input.autoSelectedPlan,
  })

  if (planSynced.permissionMode === 'plan' && planSynced.autoSelectedPlan) {
    return planSynced
  }

  return {
    permissionMode: input.nextDefaultPermissionMode,
    autoSelectedPlan: false,
  }
}

export function resolveAgentInputConfigWorkspaceSlug(input: {
  threadWorkspaceId?: string | null
  currentWorkspaceId?: string | null
  workspaces: AgentInputConfigWorkspace[]
}): string | undefined {
  const workspaceId = input.threadWorkspaceId ?? input.currentWorkspaceId
  return input.workspaces.find((workspace) => workspace.id === workspaceId)?.slug
}

interface PlusPanelNavigationInput {
  current: number
  direction: number
  total: number
}

/**
 * 计算 ＋ 面板上下方向键移动后的焦点索引。
 *
 * 边界策略（交互决策点，留给你定）：
 *  - 当前实现：夹紧（clamp）—— 到顶/底不动，行为可预期、不会"跳"。
 *  - 备选：循环（wrap）—— 到底回到顶，适合纯键盘快速浏览，但会失去"边界感"。
 *
 * 若想改成循环：把 return 那行换成 `(current + direction + total) % total` 即可。
 */
export function resolveNextActiveIndex(input: PlusPanelNavigationInput): number {
  const { current, direction, total } = input
  if (total <= 0) return 0
  // TODO(contributor): 边界行为当前为夹紧；如需循环改为 (current + direction + total) % total
  const next = current + direction
  return Math.max(0, Math.min(next, total - 1))
}
