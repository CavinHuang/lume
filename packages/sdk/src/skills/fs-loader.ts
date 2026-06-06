import { readdir, readFile } from 'fs/promises'
import { homedir } from 'os'
import { isAbsolute, join, resolve } from 'path'
import type { SkillDefinition } from './types.js'
import {
  parseBooleanFrontmatter,
  parseMarkdownFrontmatter,
} from '../utils/markdown-frontmatter.js'

async function tryReadDir(path: string) {
  try {
    return await readdir(path, { withFileTypes: true })
  } catch {
    return []
  }
}

function cleanFrontmatterString(value?: string): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed) return undefined
  return trimmed.replace(/^["']|["']$/g, '')
}

function pickFrontmatterString(
  frontmatter: Record<string, string>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = cleanFrontmatterString(frontmatter[key])
    if (value) return value
  }
  return undefined
}

function pickFrontmatterBoolean(
  frontmatter: Record<string, string>,
  defaultValue: boolean,
  ...keys: string[]
): boolean {
  for (const key of keys) {
    if (frontmatter[key] !== undefined) {
      return parseBooleanFrontmatter(cleanFrontmatterString(frontmatter[key]), defaultValue)
    }
  }
  return defaultValue
}

function parseFrontmatterList(value?: string): string[] {
  const cleaned = cleanFrontmatterString(value)
  if (!cleaned) return []

  const inlineList = cleaned.startsWith('[') && cleaned.endsWith(']')
    ? cleaned.slice(1, -1)
    : cleaned

  return inlineList
    .split(',')
    .map((item) => cleanFrontmatterString(item))
    .filter((item): item is string => Boolean(item))
}

function pickFrontmatterList(
  frontmatter: Record<string, string>,
  ...keys: string[]
): string[] {
  for (const key of keys) {
    const parsed = parseFrontmatterList(frontmatter[key])
    if (parsed.length > 0) return parsed
  }
  return []
}

function getSkillSortLabel(skill: SkillDefinition): string {
  return skill.aliases?.[0] ?? skill.name
}

function getDefaultUserSkillsRoot(): string {
  const configDir = process.env.LUME_CONFIG_DIR?.trim()
  const resolvedConfigDir = configDir
    ? isAbsolute(configDir) ? configDir : resolve(process.cwd(), configDir)
    : join(homedir(), '.lume')
  return join(resolvedConfigDir, 'skills')
}

export interface LoadFilesystemSkillsInput {
  cwd: string
  roots?: string[]
}

export async function loadFilesystemSkills(
  input: string | LoadFilesystemSkillsInput,
): Promise<SkillDefinition[]> {
  const resolvedInput: LoadFilesystemSkillsInput =
    typeof input === 'string'
      ? { cwd: input }
      : input

  const explicitRoots = Array.isArray(resolvedInput.roots)
    ? resolvedInput.roots.filter((root): root is string => typeof root === 'string' && root.trim().length > 0)
    : []
  const defaultRoots = explicitRoots.length === 0
    ? [getDefaultUserSkillsRoot(), join(resolvedInput.cwd, '.lume', 'skills')]
    : []
  const roots = Array.from(new Set([...defaultRoots, ...explicitRoots]))

  const skills: SkillDefinition[] = []

  for (const root of roots) {
    const entries = await tryReadDir(root)
    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const skillName = entry.name
      const skillFile = join(root, skillName, 'SKILL.md')
      try {
        const raw = await readFile(skillFile, 'utf-8')
        const parsed = parseMarkdownFrontmatter(raw)
        const body = parsed.content
        if (!body) continue
        const displayName = pickFrontmatterString(parsed.frontmatter, 'name')
        const aliases = displayName && displayName !== skillName ? [displayName] : undefined

        skills.push({
          name: skillName,
          sourcePath: skillFile,
          description:
            pickFrontmatterString(parsed.frontmatter, 'description') ||
            body.split(/\r?\n/).find(Boolean) ||
            `Skill ${skillName}`,
          ...(aliases ? { aliases } : {}),
          whenToUse: pickFrontmatterString(parsed.frontmatter, 'when_to_use', 'whenToUse', 'when-to-use'),
          argumentHint: pickFrontmatterString(parsed.frontmatter, 'argument_hint', 'argumentHint', 'argument-hint'),
          version: pickFrontmatterString(parsed.frontmatter, 'version'),
          allowedTools: pickFrontmatterList(
            parsed.frontmatter,
            'allowed_tools',
            'allowedTools',
            'allowed-tools',
          ),
          model: pickFrontmatterString(parsed.frontmatter, 'model'),
          userInvocable: pickFrontmatterBoolean(
            parsed.frontmatter,
            true,
            'user_invocable',
            'userInvocable',
            'user-invocable',
          ),
          disableModelInvocation: pickFrontmatterBoolean(
            parsed.frontmatter,
            false,
            'disable_model_invocation',
            'disableModelInvocation',
            'disable-model-invocation',
          ),
          context: parsed.frontmatter.context === 'fork' ? 'fork' : 'inline',
          agent: pickFrontmatterString(parsed.frontmatter, 'agent'),
          getPrompt: async (args) => [{ type: 'text', text: body.replaceAll('${ARG}', args) }],
        })
      } catch {
        // Ignore unreadable or invalid skill files.
      }
    }
  }

  const byName = new Map<string, SkillDefinition>()
  for (const skill of skills) {
    byName.set(skill.name, skill)
  }

  return Array.from(byName.values()).sort((a, b) => {
    const byLabel = getSkillSortLabel(a).localeCompare(getSkillSortLabel(b))
    return byLabel || a.name.localeCompare(b.name)
  })
}
