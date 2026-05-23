import {
  BUILTIN_AGENT_ROLES,
  getAgentRole,
  suggestAgentRoles,
  type AgentRoleDefinition,
  type AgentRoleId,
} from '@lume/shared'
import type { MentionItem } from './slash-command-state'

export interface AgentInputRoleRecommendation {
  role: AgentRoleDefinition
  label: string
  score: number
  matchedKeywords: string[]
}

const MAX_AGENT_INPUT_RECOMMENDATIONS = 3
const MAX_AGENT_MENTION_ITEMS = 6

export function buildAgentInputRoleRecommendations(input: string): AgentInputRoleRecommendation[] {
  if (input.trim().length === 0) return []

  return suggestAgentRoles(input)
    .slice(0, MAX_AGENT_INPUT_RECOMMENDATIONS)
    .map((suggestion) => {
      const role = getAgentRole(suggestion.roleId)
      if (!role) return null
      return {
        role,
        label: `${role.displayName} · ${role.title}`,
        score: suggestion.score,
        matchedKeywords: suggestion.matchedKeywords,
      }
    })
    .filter((item): item is AgentInputRoleRecommendation => item !== null)
}

export function applyAgentRoleRecommendation(input: string, roleId: AgentRoleId): string {
  const trimmed = input.trim()
  const instruction = `请调用 Agent 工具，并将 subagent_type 设置为 "${roleId}" 来处理这个任务：`

  if (trimmed.startsWith(instruction)) {
    return trimmed
  }

  return trimmed.length > 0 ? `${instruction}\n${trimmed}` : instruction
}

export function buildAgentRoleMentionItems(query: string): MentionItem[] {
  const normalizedQuery = query.trim().toLowerCase()

  return BUILTIN_AGENT_ROLES
    .filter((role) => matchesAgentRoleMentionQuery(role, normalizedQuery))
    .slice(0, MAX_AGENT_MENTION_ITEMS)
    .map((role) => ({
      id: role.id,
      label: role.id,
      type: 'agent' as const,
      title: `${role.displayName} · ${role.title}`,
      subtitle: role.description,
      section: 'agent' as const,
      meta: role.defaultBackground ? '后台' : '前台',
    }))
}

export function applyAgentRoleMentions(input: string): string {
  const match = findAgentRoleMention(input)
  if (!match) return input.trim()

  const textWithoutMention = `${input.slice(0, match.start)}${input.slice(match.end)}`
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
  return applyAgentRoleRecommendation(textWithoutMention, match.role.id)
}

function matchesAgentRoleMentionQuery(role: AgentRoleDefinition, normalizedQuery: string): boolean {
  if (!normalizedQuery) return true
  return getAgentRoleMentionAliases(role).some((alias) => alias.toLowerCase().includes(normalizedQuery))
}

function findAgentRoleMention(input: string): { role: AgentRoleDefinition; start: number; end: number } | null {
  const mentionPattern = /(^|\s)@([^\s@/#]+)/gu
  for (const match of input.matchAll(mentionPattern)) {
    const token = normalizeAgentRoleMentionToken(match[2] ?? '')
    const role = resolveAgentRoleMentionToken(token)
    if (!role || typeof match.index !== 'number') continue
    const prefix = match[1] ?? ''
    return {
      role,
      start: match.index + prefix.length,
      end: match.index + match[0].length,
    }
  }
  return null
}

function resolveAgentRoleMentionToken(token: string): AgentRoleDefinition | undefined {
  const normalizedToken = token.toLowerCase()
  return BUILTIN_AGENT_ROLES.find((role) => (
    getAgentRoleMentionAliases(role).some((alias) => alias.toLowerCase() === normalizedToken)
  ))
}

function normalizeAgentRoleMentionToken(token: string): string {
  return token.replace(/[，。！？、,.!?:;；：）)】\]]+$/u, '')
}

function getAgentRoleMentionAliases(role: AgentRoleDefinition): string[] {
  return [
    role.id,
    role.displayName,
    role.title,
    role.name,
    role.defaultSkillName,
    ...role.keywords,
  ]
}
