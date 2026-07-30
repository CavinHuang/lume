const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n?/g, '\n').replace(/\n?$/, '\n')
}

function syntheticHunk(lines: string[]): string {
  let deletions = 0
  let additions = 0
  for (const line of lines) {
    if (line.startsWith('-') && !line.startsWith('---')) deletions += 1
    else if (line.startsWith('+') && !line.startsWith('+++')) additions += 1
    else if (line.startsWith(' ')) {
      deletions += 1
      additions += 1
    }
  }
  return `@@ -1,${deletions} +1,${additions} @@`
}

export function normalizeDiffSnippet(source: string, path = 'snippet.diff'): string {
  const normalized = normalizeNewlines(source)
  const lines = normalized.slice(0, -1).split('\n')
  const firstContent = lines.find((line) => line.trim().length > 0) ?? ''

  if (firstContent.startsWith('diff --git ')) return normalized
  if (lines.some((line, index) => line.startsWith('--- ') && lines[index + 1]?.startsWith('+++ '))) {
    return normalized
  }

  const safePath = path.replace(/\\/g, '/').replace(/^\/+/, '') || 'snippet.diff'
  if (HUNK_HEADER.test(firstContent)) {
    return `--- a/${safePath}\n+++ b/${safePath}\n${normalized}`
  }

  const body = lines.filter((line) => line.length > 0)
  if (body.length === 0 || body.some((line) => !/^[ +\-\\]/.test(line))) {
    throw new Error('内容不是可识别的 unified diff')
  }
  return [
    `--- a/${safePath}`,
    `+++ b/${safePath}`,
    syntheticHunk(body),
    ...body,
    '',
  ].join('\n')
}

