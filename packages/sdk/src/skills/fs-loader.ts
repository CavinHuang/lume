import { readdir, readFile } from 'fs/promises'
import { homedir } from 'os'
import { isAbsolute, join, resolve } from 'path'
import { createHash } from 'crypto'
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

function resolveMaybeRelativePath(path: string): string {
  return isAbsolute(path) ? path : resolve(process.cwd(), path)
}

function getDefaultUserSkillsRoot(): string {
  const configDir = process.env.LUME_CONFIG_DIR?.trim()
  const resolvedConfigDir = configDir
    ? resolveMaybeRelativePath(configDir)
    : join(homedir(), '.lume')
  return join(resolvedConfigDir, 'skills')
}

function getDefaultAliceUserSkillsRoot(): string {
  const aliceConfigDir = process.env.ALICE_CONFIG_DIR?.trim()
  if (aliceConfigDir) {
    return join(resolveMaybeRelativePath(aliceConfigDir), 'skills')
  }

  const lumeConfigDir = process.env.LUME_CONFIG_DIR?.trim()
  if (lumeConfigDir) {
    return join(resolveMaybeRelativePath(lumeConfigDir), '.alice', 'skills')
  }

  return join(homedir(), '.alice', 'skills')
}

export interface LoadFilesystemSkillsInput {
  cwd: string
  roots?: string[]
  shouldLoadSkill?: (input: {
    root: string
    skillName: string
    skillFile: string
  }) => boolean
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
    ? [
        getDefaultUserSkillsRoot(),
        getDefaultAliceUserSkillsRoot(),
        join(resolvedInput.cwd, '.lume', 'skills'),
        join(resolvedInput.cwd, '.alice', 'skills'),
      ]
    : []
  const roots = Array.from(new Set([...defaultRoots, ...explicitRoots]))

  const skills: SkillDefinition[] = []

  for (const root of roots) {
    const entries = await tryReadDir(root)
    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const skillName = entry.name
      const skillFile = join(root, skillName, 'SKILL.md')
      if (resolvedInput.shouldLoadSkill && !resolvedInput.shouldLoadSkill({ root, skillName, skillFile })) {
        continue
      }
      try {
        const raw = await readFile(skillFile, 'utf-8')
        const parsed = parseMarkdownFrontmatter(raw)
        const body = parsed.content
        if (!body) continue
        const displayName = pickFrontmatterString(parsed.frontmatter, 'name')
        const aliases = displayName && displayName !== skillName ? [displayName] : undefined
        const allowedTools = pickFrontmatterList(
          parsed.frontmatter,
          'allowed_tools',
          'allowedTools',
          'allowed-tools',
        )
        const activatedTools = pickFrontmatterList(
          parsed.frontmatter,
          'activate_tools',
          'activateTools',
          'activate-tools',
        )
        const model = pickFrontmatterString(parsed.frontmatter, 'model')
        const version = pickFrontmatterString(parsed.frontmatter, 'version')
        const context = parsed.frontmatter.context === 'fork' ? 'fork' : 'inline'
        const agent = pickFrontmatterString(parsed.frontmatter, 'agent')

        skills.push({
          name: skillName,
          sourcePath: skillFile,
          description:
            pickFrontmatterString(parsed.frontmatter, 'description') ||
            body.split(/\r?\n/).find(Boolean) ||
            `Skill ${skillName}`,
          ...(aliases ? { aliases } : {}),
          argumentHint: pickFrontmatterString(parsed.frontmatter, 'argument_hint', 'argumentHint', 'argument-hint'),
          version,
          allowedTools,
          activatedTools,
          model,
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
          context,
          agent,
          invocationDescriptor: {
            promptTemplate: body,
            argumentToken: '${ARG}',
            ...(allowedTools.length > 0 ? { allowedTools } : {}),
            ...(model ? { model } : {}),
            context,
            ...(agent ? { agent } : {}),
            ...(version ? { version } : {}),
            fingerprint: createHash('sha256').update(raw).digest('hex'),
          },
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
