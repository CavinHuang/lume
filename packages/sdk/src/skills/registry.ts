/**
 * Skill Registry
 *
 * Central registry for managing skill definitions.
 * Skills can be registered programmatically or loaded from bundled definitions.
 */

import type { SkillDefinition } from './types.js'

/** Agent/session-owned skill lookup. It never falls back to another owner. */
export class SkillRegistry {
  private readonly skills = new Map<string, SkillDefinition>()
  private readonly normalizedNames = new Map<string, string>()
  private readonly aliases = new Map<string, string>()

  constructor(definitions: SkillDefinition[] = []) {
    for (const definition of definitions) this.register(definition)
  }

  register(definition: SkillDefinition): SkillDefinition | undefined {
    const normalizedName = normalizeSkillKey(definition.name)
    const previousName = this.normalizedNames.get(normalizedName) ?? definition.name
    const previous = this.skills.get(previousName)
    if (previous) {
      this.unregisterAliases(previous)
      if (previousName !== definition.name) this.skills.delete(previousName)
    }
    this.skills.set(definition.name, definition)
    this.normalizedNames.set(normalizedName, definition.name)
    for (const alias of definition.aliases ?? []) {
      this.aliases.set(normalizeSkillKey(alias), definition.name)
    }
    return previous
  }

  get(name: string): SkillDefinition | undefined {
    const direct = this.skills.get(name)
    if (direct) return direct
    const normalized = normalizeSkillKey(name)
    const canonical = this.normalizedNames.get(normalized)
    if (canonical) return this.skills.get(canonical)
    const alias = this.aliases.get(normalized)
    if (alias) return this.skills.get(alias)
    const unprefixed = stripWorkspacePrefix(name)
    return unprefixed === name ? undefined : this.get(unprefixed)
  }

  getAll(): SkillDefinition[] {
    return Array.from(this.skills.values())
  }

  getUserInvocable(): SkillDefinition[] {
    return this.getAll().filter((skill) => skill.userInvocable !== false && (!skill.isEnabled || skill.isEnabled()))
  }

  getModelInvocable(): SkillDefinition[] {
    return this.getUserInvocable().filter((skill) => skill.disableModelInvocation !== true)
  }

  unregister(name: string): boolean {
    const skill = this.get(name)
    if (!skill) return false
    this.normalizedNames.delete(normalizeSkillKey(skill.name))
    this.unregisterAliases(skill)
    return this.skills.delete(skill.name)
  }

  clear(): void {
    this.skills.clear()
    this.normalizedNames.clear()
    this.aliases.clear()
  }

  private unregisterAliases(skill: SkillDefinition): void {
    for (const alias of skill.aliases ?? []) this.aliases.delete(normalizeSkillKey(alias))
  }
}

/** Global singleton backing the module-level convenience functions (#389). */
const globalRegistry = new SkillRegistry()

function stripWorkspacePrefix(name: string): string {
  const separatorIndex = name.lastIndexOf(':')
  if (separatorIndex < 0) return name
  return name.slice(separatorIndex + 1)
}

function normalizeSkillKey(name: string): string {
  return name.trim().toLowerCase()
}

/**
 * Register a skill definition.
 */
export function registerSkill(definition: SkillDefinition): void {
  const previous = globalRegistry.register(definition)
  if (previous && previous.name !== definition.name) {
    console.warn(`[SkillRegistry] Overwriting skill "${previous.name}" with "${definition.name}"`)
  }
}

/**
 * Get a skill by name or alias.
 */
export function getSkill(name: string): SkillDefinition | undefined {
  return globalRegistry.get(name)
}

/**
 * Get all registered skills.
 */
export function getAllSkills(): SkillDefinition[] {
  return globalRegistry.getAll()
}

/**
 * Get all user-invocable skills (for /command listing).
 */
export function getUserInvocableSkills(): SkillDefinition[] {
  return globalRegistry.getUserInvocable()
}

/**
 * Get skills that the model may see and invoke automatically.
 */
export function getModelInvocableSkills(): SkillDefinition[] {
  return globalRegistry.getModelInvocable()
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
  return globalRegistry.unregister(name)
}

/**
 * Clear all skills (for testing).
 */
export function clearSkills(): void {
  globalRegistry.clear()
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

    const args = skill.argumentHint
      ? ` ARGS: ${skill.argumentHint}`
      : ''

    const line = `- ${skill.name}: ${desc}${args}`

    if (used + line.length > budget) break
    lines.push(line)
    used += line.length
  }

  return lines.join('\n')
}

export interface SkillCatalogOptions {
  /** Maximum total catalog characters before entries are dropped. */
  budgetChars?: number
  /** Maximum description characters per entry. */
  maxDescChars?: number
}

const DEFAULT_CATALOG_BUDGET_CHARS = 8000
const DEFAULT_CATALOG_DESC_CHARS = 250

/**
 * Render the model-facing `<available_skills>` catalog block.
 *
 * Entries carry name (plus display alias), a truncated description and an
 * argument hint — summaries only, mirroring the Skill tool's progressive
 * disclosure: full bodies are loaded via the tool.
 */
export function renderSkillCatalog(
  skills: SkillDefinition[],
  options: SkillCatalogOptions = {},
): string {
  if (skills.length === 0) return ''

  const budget = options.budgetChars ?? DEFAULT_CATALOG_BUDGET_CHARS
  const maxDescChars = options.maxDescChars ?? DEFAULT_CATALOG_DESC_CHARS

  const lines: string[] = []
  let used = 0
  for (const skill of skills) {
    const desc = skill.description.length > maxDescChars
      ? skill.description.slice(0, maxDescChars - 3) + '...'
      : skill.description
    const alias = skill.aliases
      ?.map((item) => item.trim())
      .find((item) => item && item !== skill.name)
    const name = alias ? `${skill.name} (${alias})` : skill.name
    const args = skill.argumentHint ? ` (args: ${skill.argumentHint})` : ''
    const line = `- ${name}: ${desc}${args}`
    if (used + line.length > budget) break
    lines.push(line)
    used += line.length
  }
  if (lines.length === 0) return ''

  return [
    '<available_skills>',
    ...lines,
    '</available_skills>',
    '',
    'When the user names a skill above or the task clearly matches a skill description, call the Skill tool with the exact skill name before taking task actions. This catalog contains summaries only; follow a skill\'s full instructions only after loading it with the Skill tool.',
  ].join('\n')
}
