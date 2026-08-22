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
    if (line === undefined) continue
    if (line === '---') {
      endIndex = index
      break
    }

    const separatorIndex = line.indexOf(':')
    if (separatorIndex === -1) continue

    const key = line.slice(0, separatorIndex).trim()
    const value = line.slice(separatorIndex + 1).trim()
    if (key) {
      if (value.startsWith('|') || value.startsWith('>')) {
        const block = readIndentedFrontmatterBlock(lines, index + 1)
        frontmatter[key] = value.startsWith('|')
          ? block.lines.join('\n').trim()
          : block.lines.join(' ').replace(/\s+/g, ' ').trim()
        index = block.nextIndex - 1
      } else if (!value) {
        const items: string[] = []
        let nextIndex = index + 1
        for (; nextIndex < lines.length; nextIndex++) {
          const nextLine = lines[nextIndex]
          if (nextLine === undefined) continue
          if (nextLine === '---') break
          const trimmed = nextLine.trim()
          if (!trimmed) continue
          // Standard YAML allows top-level list items; scanning stops at the
          // next key-shaped line or the closing fence (#350).
          if (!trimmed.startsWith('- ')) break
          const item = trimmed.slice(2).trim()
          if (item) items.push(item)
        }
        frontmatter[key] = items.join(',')
        if (items.length === 0) {
          console.warn(
            `[frontmatter] list value for key "${key}" has no "- " items; key is empty`,
          )
        } else {
          index = nextIndex - 1
        }
      } else {
        frontmatter[key] = value
      }
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

function readIndentedFrontmatterBlock(
  lines: string[],
  startIndex: number,
): { lines: string[]; nextIndex: number } {
  const rawLines: string[] = []
  let nextIndex = startIndex

  for (; nextIndex < lines.length; nextIndex++) {
    const line = lines[nextIndex]
    if (line === undefined) continue
    if (line === '---') break
    if (!line.trim()) {
      rawLines.push('')
      continue
    }
    if (!line.startsWith(' ') && !line.startsWith('\t')) break
    rawLines.push(line)
  }

  const indents = rawLines
    .filter((line) => line.trim())
    .map((line) => line.match(/^[ \t]*/)?.[0]?.length ?? 0)
    .filter((length) => length > 0)
  const indent = indents.length > 0 ? Math.min(...indents) : 0

  return {
    lines: rawLines.map((line) => line.trim() ? line.slice(indent) : ''),
    nextIndex,
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
