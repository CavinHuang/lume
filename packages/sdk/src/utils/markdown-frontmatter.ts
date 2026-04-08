export interface ParsedMarkdownFrontmatter {
  frontmatter: Record<string, string>
  content: string
}

export function parseMarkdownFrontmatter(
  source: string,
): ParsedMarkdownFrontmatter {
  if (!source.startsWith('---\n') && !source.startsWith('---\r\n')) {
    return { frontmatter: {}, content: source.trim() }
  }

  const lines = source.split(/\r?\n/)
  if (lines[0] !== '---') {
    return { frontmatter: {}, content: source.trim() }
  }

  let endIndex = -1
  const frontmatter: Record<string, string> = {}

  for (let index = 1; index < lines.length; index++) {
    const line = lines[index]
    if (line === '---') {
      endIndex = index
      break
    }

    const separatorIndex = line.indexOf(':')
    if (separatorIndex === -1) continue

    const key = line.slice(0, separatorIndex).trim()
    const value = line.slice(separatorIndex + 1).trim()
    if (key) {
      frontmatter[key] = value
    }
  }

  if (endIndex === -1) {
    return { frontmatter: {}, content: source.trim() }
  }

  return {
    frontmatter,
    content: lines.slice(endIndex + 1).join('\n').trim(),
  }
}

export function parseListFrontmatter(value?: string): string[] {
  if (!value) return []

  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

export function parseBooleanFrontmatter(
  value?: string,
  defaultValue = true,
): boolean {
  if (value === undefined) {
    return defaultValue
  }

  const lowered = value.toLowerCase()
  if (['true', '1', 'yes', 'on'].includes(lowered)) {
    return true
  }
  if (['false', '0', 'no', 'off'].includes(lowered)) {
    return false
  }
  return defaultValue
}
