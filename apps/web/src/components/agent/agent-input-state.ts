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
