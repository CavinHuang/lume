const PLUGIN_PREFIX = 'lume-plugin://'
const SKILL_PREFIX = 'lume-skill://'
const MAX_COMPONENT_LENGTH = 512
const INVALID_COMPONENT_TEXT = /[\u0000-\u0020\u007f]/u

export type LumeCapabilityReference =
  | {
      kind: 'plugin'
      uri: string
      pluginId: string
    }
  | {
      kind: 'skill'
      uri: string
      skillSlug: string
      pluginId?: string
    }

export type LumeCapabilityReferenceErrorCode =
  | 'empty_component'
  | 'invalid_component'
  | 'invalid_encoding'
  | 'non_canonical_encoding'
  | 'component_too_long'

export class LumeCapabilityReferenceError extends Error {
  constructor(
    readonly code: LumeCapabilityReferenceErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'LumeCapabilityReferenceError'
  }
}

export function formatLumePluginReference(pluginId: string): string {
  return `${PLUGIN_PREFIX}${encodeComponent(pluginId)}`
}

export function formatLumeSkillReference(skillSlug: string, pluginId?: string): string {
  const encodedSkill = encodeComponent(skillSlug)
  return pluginId === undefined
    ? `${SKILL_PREFIX}${encodedSkill}`
    : `${SKILL_PREFIX}${encodeComponent(pluginId)}:${encodedSkill}`
}

/**
 * Parse Lume's case-sensitive lexical reference format.
 *
 * These references intentionally do not use WHATWG URL authority semantics:
 * plugin-skill references use the first raw colon as a component separator,
 * and registry identifiers retain their original case.
 */
export function parseLumeCapabilityReference(input: string): LumeCapabilityReference | null {
  if (input.startsWith(PLUGIN_PREFIX)) {
    const pluginId = decodeComponent(input.slice(PLUGIN_PREFIX.length))
    return {
      kind: 'plugin',
      uri: formatLumePluginReference(pluginId),
      pluginId,
    }
  }

  if (!input.startsWith(SKILL_PREFIX)) return null

  const raw = input.slice(SKILL_PREFIX.length)
  const separatorIndex = raw.indexOf(':')
  if (separatorIndex < 0) {
    const skillSlug = decodeComponent(raw)
    return {
      kind: 'skill',
      uri: formatLumeSkillReference(skillSlug),
      skillSlug,
    }
  }

  const pluginId = decodeComponent(raw.slice(0, separatorIndex))
  const skillSlug = decodeComponent(raw.slice(separatorIndex + 1))
  return {
    kind: 'skill',
    uri: formatLumeSkillReference(skillSlug, pluginId),
    pluginId,
    skillSlug,
  }
}

export function normalizeLumeCapabilityReferences(
  inputs: readonly (string | LumeCapabilityReference)[],
): LumeCapabilityReference[] {
  const parsed = inputs.map((input) => {
    if (typeof input !== 'string') return input
    const reference = parseLumeCapabilityReference(input)
    if (!reference) {
      throw new LumeCapabilityReferenceError('invalid_component', `Not a Lume capability reference: ${input}`)
    }
    return reference
  })
  const wholePlugins = new Set(
    parsed.filter((reference) => reference.kind === 'plugin').map((reference) => reference.pluginId),
  )
  const seen = new Set<string>()
  const result: LumeCapabilityReference[] = []
  for (const reference of parsed) {
    if (reference.kind === 'skill' && reference.pluginId && wholePlugins.has(reference.pluginId)) {
      continue
    }
    if (seen.has(reference.uri)) continue
    seen.add(reference.uri)
    result.push(reference)
  }
  return result
}

function encodeComponent(value: string): string {
  validateDecodedComponent(value)
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%[0-9a-f]{2}/gi, (sequence) => sequence.toUpperCase())
}

function decodeComponent(raw: string): string {
  if (!raw) {
    throw new LumeCapabilityReferenceError('empty_component', 'Capability reference components cannot be empty')
  }
  let decoded: string
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    throw new LumeCapabilityReferenceError('invalid_encoding', `Invalid capability reference encoding: ${raw}`)
  }
  validateDecodedComponent(decoded)
  if (encodeComponent(decoded) !== raw) {
    throw new LumeCapabilityReferenceError(
      'non_canonical_encoding',
      `Capability reference component is not canonically encoded: ${raw}`,
    )
  }
  return decoded
}

function validateDecodedComponent(value: string): void {
  if (!value) {
    throw new LumeCapabilityReferenceError('empty_component', 'Capability reference components cannot be empty')
  }
  if (value.length > MAX_COMPONENT_LENGTH) {
    throw new LumeCapabilityReferenceError('component_too_long', 'Capability reference component is too long')
  }
  if (INVALID_COMPONENT_TEXT.test(value)) {
    throw new LumeCapabilityReferenceError(
      'invalid_component',
      'Capability reference components cannot contain whitespace or control characters',
    )
  }
}
