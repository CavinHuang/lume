import { readdir, readFile } from 'fs/promises'
import { basename, join, relative, resolve } from 'path'
import type { CommandDefinition } from './types.js'
import { parseMarkdownFrontmatter } from '../utils/markdown-frontmatter.js'

async function tryReadDir(path: string) {
  try {
    return await readdir(path, { withFileTypes: true })
  } catch {
    return []
  }
}

async function collectMarkdownFiles(dir: string): Promise<string[]> {
  const entries = await tryReadDir(dir)
  const files: string[] = []

  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...await collectMarkdownFiles(fullPath))
      continue
    }

    if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(fullPath)
    }
  }

  return files
}

function buildCommandName(filePath: string, rootDir: string): string {
  const relativePath = relative(rootDir, filePath).replace(/\\/g, '/')
  const withoutExtension = relativePath.replace(/\.md$/i, '')
  return withoutExtension.split('/').filter(Boolean).join(':')
}

export async function loadCommandDefinitions(
  cwd: string,
): Promise<CommandDefinition[]> {
  const home = process.env.HOME || process.env.USERPROFILE || cwd
  const roots = [
    { dir: join(home, '.claude', 'commands'), source: 'user' },
    { dir: join(cwd, '.claude', 'commands'), source: 'project' },
  ] as const

  const commands: CommandDefinition[] = []

  for (const root of roots) {
    const files = await collectMarkdownFiles(root.dir)
    for (const filePath of files) {
      try {
        const raw = await readFile(filePath, 'utf-8')
        const parsed = parseMarkdownFrontmatter(raw)
        const description =
          parsed.frontmatter.description ||
          parsed.content.split(/\r?\n/).find(Boolean) ||
          `Command loaded from ${basename(filePath)}`
        const name =
          parsed.frontmatter.name || buildCommandName(filePath, root.dir)

        commands.push({
          name,
          description,
          argumentHint: parsed.frontmatter['argument-hint'],
          source: root.source,
          path: resolve(filePath),
        })
      } catch {
        // Ignore invalid command files.
      }
    }
  }

  const byName = new Map<string, CommandDefinition>()
  for (const command of commands) {
    byName.set(command.name, command)
  }

  return Array.from(byName.values())
}

export function commandDefinitionsToSlashCommands(
  commands: CommandDefinition[],
) {
  return commands.map((command) => ({
    name: `/${command.name}`,
    description: command.description,
    argumentHint: command.argumentHint,
  }))
}
