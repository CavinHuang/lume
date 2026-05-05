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

export function syncPermissionModeWithPlanModePhase(input: PermissionPlanSyncInput): PermissionPlanSyncOutput {
  const planActive = input.planPhase === 'planning' || input.planPhase === 'review'
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
