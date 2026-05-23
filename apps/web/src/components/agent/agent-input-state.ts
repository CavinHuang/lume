import type { PlanModePhase } from '@lume/shared'
import type { PermissionModeValue } from '@/components/settings/agent-settings-state'

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

interface AgentInputEnterEvent {
  key: string
  shiftKey: boolean
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
