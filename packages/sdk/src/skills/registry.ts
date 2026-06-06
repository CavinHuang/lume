/**
 * Skill Registry
 *
 * Central registry for managing skill definitions.
 * Skills can be registered programmatically or loaded from bundled definitions.
 */

import type { SkillDefinition } from './types.js'

/** Internal skill store */
const skills: Map<string, SkillDefinition> = new Map()

/** Lowercase skill name -> canonical skill name */
const normalizedNames: Map<string, string> = new Map()

/** Alias -> skill name mapping */
const aliases: Map<string, string> = new Map()

function stripWorkspacePrefix(name: string): string {
  const separatorIndex = name.lastIndexOf(':')
  if (separatorIndex < 0) return name
  return name.slice(separatorIndex + 1)
}

function normalizeSkillKey(name: string): string {
  return name.trim().toLowerCase()
}

function unregisterSkillAliases(skill: SkillDefinition): void {
  if (!skill.aliases) return
  for (const alias of skill.aliases) {
    aliases.delete(normalizeSkillKey(alias))
  }
}

/**
 * Register a skill definition.
 */
export function registerSkill(definition: SkillDefinition): void {
  const normalizedName = normalizeSkillKey(definition.name)
  const previousName = normalizedNames.get(normalizedName) ?? definition.name
  const previous = skills.get(previousName)
  if (previous) {
    unregisterSkillAliases(previous)
    if (previousName !== definition.name) {
      skills.delete(previousName)
    }
  }

  skills.set(definition.name, definition)
  normalizedNames.set(normalizedName, definition.name)

  // Register aliases
  if (definition.aliases) {
    for (const alias of definition.aliases) {
      aliases.set(normalizeSkillKey(alias), definition.name)
    }
  }
}

/**
 * Get a skill by name or alias.
 */
export function getSkill(name: string): SkillDefinition | undefined {
  // Direct lookup
  const direct = skills.get(name)
  if (direct) return direct

  const normalizedName = normalizeSkillKey(name)
  const normalizedSkillName = normalizedNames.get(normalizedName)
  if (normalizedSkillName) return skills.get(normalizedSkillName)

  // Alias lookup
  const resolved = aliases.get(normalizedName)
  if (resolved) return skills.get(resolved)

  const unprefixed = stripWorkspacePrefix(name)
  if (unprefixed !== name) {
    return getSkill(unprefixed)
  }

  return undefined
}

/**
 * Get all registered skills.
 */
export function getAllSkills(): SkillDefinition[] {
  return Array.from(skills.values())
}

/**
 * Get all user-invocable skills (for /command listing).
 */
export function getUserInvocableSkills(): SkillDefinition[] {
  return getAllSkills().filter(
    (s) => s.userInvocable !== false && (!s.isEnabled || s.isEnabled()),
  )
}

/**
 * Get skills that the model may see and invoke automatically.
 */
export function getModelInvocableSkills(): SkillDefinition[] {
  return getUserInvocableSkills().filter((s) => s.disableModelInvocation !== true)
}

/**
 * Check if a skill exists.
 */
export function hasSkill(name: string): boolean {
  return getSkill(name) !== undefined
}

/**
 * Remove a skill.
 */
export function unregisterSkill(name: string): boolean {
  const skill = skills.get(name)
  if (!skill) return false

  normalizedNames.delete(normalizeSkillKey(skill.name))

  unregisterSkillAliases(skill)

  return skills.delete(name)
}

/**
 * Clear all skills (for testing).
 */
export function clearSkills(): void {
  skills.clear()
  normalizedNames.clear()
  aliases.clear()
}

/**
 * Format skills listing for system prompt injection.
 *
 * Uses a budget system: skills listing gets a limited character budget
 * to avoid bloating the context window.
 */
export function formatSkillsForPrompt(
  contextWindowTokens?: number,
): string {
  const invocable = getModelInvocableSkills()
  if (invocable.length === 0) return ''

  // Budget: 1% of context window in characters (4 chars per token)
  const CHARS_PER_TOKEN = 4
  const DEFAULT_BUDGET = 8000
  const MAX_DESC_CHARS = 250
  const budget = contextWindowTokens
    ? Math.floor(contextWindowTokens * 0.01 * CHARS_PER_TOKEN)
    : DEFAULT_BUDGET

  const lines: string[] = []
  let used = 0

  for (const skill of invocable) {
    const desc = skill.description.length > MAX_DESC_CHARS
      ? skill.description.slice(0, MAX_DESC_CHARS) + '...'
      : skill.description

    const trigger = skill.whenToUse
      ? ` TRIGGER when: ${skill.whenToUse}`
      : ''
    const args = skill.argumentHint
      ? ` ARGS: ${skill.argumentHint}`
      : ''

    const line = `- ${skill.name}: ${desc}${trigger}${args}`

    if (used + line.length > budget) break
    lines.push(line)
    used += line.length
  }

  return lines.join('\n')
}
