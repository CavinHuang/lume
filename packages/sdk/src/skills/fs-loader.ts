import { readdir, readFile } from 'fs/promises'
import { join } from 'path'
import type { SkillDefinition } from './types.js'
import {
  parseBooleanFrontmatter,
  parseListFrontmatter,
  parseMarkdownFrontmatter,
} from '../utils/markdown-frontmatter.js'

async function tryReadDir(path: string) {
  try {
    return await readdir(path, { withFileTypes: true })
  } catch {
    return []
  }
}

export async function loadFilesystemSkills(
  cwd: string,
): Promise<SkillDefinition[]> {
  const home = process.env.HOME || process.env.USERPROFILE || cwd
  const roots = [
    join(home, '.claude', 'skills'),
    join(cwd, '.claude', 'skills'),
  ]

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

        skills.push({
          name: parsed.frontmatter.name || skillName,
          description:
            parsed.frontmatter.description ||
            body.split(/\r?\n/).find(Boolean) ||
            `Skill ${skillName}`,
          whenToUse: parsed.frontmatter.when_to_use,
          argumentHint: parsed.frontmatter['argument-hint'],
          allowedTools: parseListFrontmatter(
            parsed.frontmatter['allowed-tools'],
          ),
          model: parsed.frontmatter.model,
          userInvocable: parseBooleanFrontmatter(
            parsed.frontmatter['user-invocable'],
            true,
          ),
          context: parsed.frontmatter.context === 'fork' ? 'fork' : 'inline',
          agent: parsed.frontmatter.agent,
          getPrompt: async () => [{ type: 'text', text: body }],
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

  return Array.from(byName.values())
}
