import {
  BUILTIN_AGENT_ROLES,
  suggestAgentRoles,
  type AgentRoleDefinition,
  type AgentRoleId,
} from '@lume/shared'
import agentsTeamImage from '@/assets/agents/agents-team.jpg'
import analystImage from '@/assets/agents/analyst.jpg'
import artistImage from '@/assets/agents/artist.jpg'
import codeReviewerImage from '@/assets/agents/code-reviewer.jpg'
import designerImage from '@/assets/agents/designer.jpg'
import developerImage from '@/assets/agents/developer.jpg'
import docsmithImage from '@/assets/agents/docsmith.jpg'
import explorerImage from '@/assets/agents/explorer.jpg'
import novelistImage from '@/assets/agents/novelist.jpg'
import plannerImage from '@/assets/agents/planner.jpg'
import quantImage from '@/assets/agents/quant.jpg'
import researcherImage from '@/assets/agents/researcher.jpg'
import translatorImage from '@/assets/agents/translator.jpg'
import voiceImage from '@/assets/agents/voice.jpg'
import writerImage from '@/assets/agents/writer.jpg'

export const AGENT_ROLE_ASSETS: {
  team: string
  roles: Record<AgentRoleId, string>
} = {
  team: agentsTeamImage,
  roles: {
    explorer: explorerImage,
    planner: plannerImage,
    'code-reviewer': codeReviewerImage,
    researcher: researcherImage,
    translator: translatorImage,
    writer: writerImage,
    voice: voiceImage,
    designer: designerImage,
    artist: artistImage,
    analyst: analystImage,
    quant: quantImage,
    novelist: novelistImage,
    docsmith: docsmithImage,
    developer: developerImage,
  },
}

export interface AgentRoleMetric {
  label: string
  value: string
}

export interface AgentRoleRecommendationPreview {
  role: AgentRoleDefinition
  label: string
  score: number
  matchedKeywords: string[]
}

export function buildAgentRoleMetrics(roles: AgentRoleDefinition[] = BUILTIN_AGENT_ROLES): AgentRoleMetric[] {
  const readOnlyCount = roles.filter((role) => role.concurrency.defaultReadOnly).length
  const backgroundCount = roles.filter((role) => role.defaultBackground).length

  return [
    { label: '内置角色', value: String(roles.length) },
    { label: '只读角色', value: String(readOnlyCount) },
    { label: '后台运行', value: String(backgroundCount) },
    { label: '可写角色', value: String(roles.length - readOnlyCount) },
  ]
}

export function filterAgentRoles(query: string, roles: AgentRoleDefinition[] = BUILTIN_AGENT_ROLES): AgentRoleDefinition[] {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return roles

  return roles.filter((role) => [
    role.id,
    role.name,
    role.displayName,
    role.title,
    role.description,
    role.defaultSkillName,
    role.concurrency.outputTypes.join(' '),
    role.keywords.join(' '),
  ].some((value) => value.toLowerCase().includes(normalized)))
}

export function buildAgentRoleRecommendationPreview(input: string): AgentRoleRecommendationPreview[] {
  return suggestAgentRoles(input).map((suggestion) => {
    const role = BUILTIN_AGENT_ROLES.find((item) => item.id === suggestion.roleId)
    if (!role) return null

    return {
      role,
      label: `${role.displayName} · ${role.title}`,
      score: suggestion.score,
      matchedKeywords: suggestion.matchedKeywords,
    }
  }).filter((item): item is AgentRoleRecommendationPreview => item !== null)
}
