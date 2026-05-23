import { getAgentRole } from '@lume/shared'

interface ResolveSubagentRoleDisplayInput {
  agentType?: string
  requestedAgentId?: string
  resolvedAgentId?: string
  label?: string
}

export interface SubagentRoleDisplay {
  knownRole: boolean
  primaryLabel: string
  runtimeId: string
  badges: string[]
}

export function resolveSubagentRoleDisplay(input: ResolveSubagentRoleDisplayInput): SubagentRoleDisplay {
  const runtimeId = firstNonEmpty(input.resolvedAgentId, input.requestedAgentId, input.agentType) ?? 'general-purpose'
  const role = getAgentRole(runtimeId)

  if (!role) {
    return {
      knownRole: false,
      primaryLabel: firstNonEmpty(input.label, input.agentType) ?? 'Subagent',
      runtimeId,
      badges: [],
    }
  }

  return {
    knownRole: true,
    primaryLabel: `${role.displayName} · ${role.title}`,
    runtimeId: role.id,
    badges: [
      role.concurrency.defaultReadOnly ? '只读' : '可写',
      role.defaultBackground ? '后台' : '前台',
      role.defaultSkillName,
    ],
  }
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.map((value) => value?.trim()).find((value): value is string => !!value)
}
