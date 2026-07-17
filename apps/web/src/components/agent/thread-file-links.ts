export type ThreadFileReferenceSource = 'project' | 'session' | 'legacy-session'

export interface ThreadFileLineSelection {
  start: number
  end: number
}

export interface ParsedThreadFileReference {
  source: ThreadFileReferenceSource
  relativePath: string
  isDirectory: boolean
  lineSelection?: ThreadFileLineSelection
  protocolReference: string
  copyText: string
}

const MAX_REFERENCE_LENGTH = 1024
const MAX_LINE_NUMBER = 2_147_483_647
const LINE_ANCHOR = /#L(\d+)(?:-L(\d+))?$/
const ENCODED_BYTE = /%[0-9a-f]{2}/i

export function parseThreadFileReference(
  value: string,
  options: { markdownHref?: boolean } = {},
): ParsedThreadFileReference | null {
  if (!value || value.length > MAX_REFERENCE_LENGTH) return null
  if (value.startsWith('@project/')) return parseStrictReference(value, 'project', options)
  if (value.startsWith('@session/')) return parseStrictReference(value, 'session', options)
  return parseLegacySessionReference(value)
}

function parseStrictReference(
  value: string,
  source: 'project' | 'session',
  options: { markdownHref?: boolean },
): ParsedThreadFileReference | null {
  if (value !== value.trim() || value.includes('\\') || /[\0-\x1f\x7f]/.test(value)) return null
  if (options.markdownHref && /\s/.test(value)) return null
  const prefix = `@${source}/`
  let encodedPath = value.slice(prefix.length)
  if (!encodedPath) return null

  let lineSelection: ThreadFileLineSelection | undefined
  const anchor = encodedPath.match(LINE_ANCHOR)
  if (anchor) {
    encodedPath = encodedPath.slice(0, -anchor[0].length)
    const start = Number(anchor[1])
    const end = Number(anchor[2] ?? anchor[1])
    if (!validLine(start) || !validLine(end) || end < start) return null
    lineSelection = { start, end }
  }

  const isDirectory = encodedPath.endsWith('/')
  if (isDirectory && lineSelection) return null
  const encodedSegments = encodedPath.split('/')
  if (isDirectory) encodedSegments.pop()
  if (encodedSegments.length === 0 || encodedSegments.some((segment) => !segment)) return null

  const decodedSegments: string[] = []
  for (const encoded of encodedSegments) {
    let decoded: string
    try {
      decoded = decodeURIComponent(encoded)
    } catch {
      return null
    }
    if (
      !decoded
      || (decodedSegments.length === 0 && /^[a-z]:$/i.test(decoded))
      || decoded === '.'
      || decoded === '..'
      || decoded.includes('/')
      || decoded.includes('\\')
      || /[\0-\x1f\x7f]/.test(decoded)
      || ENCODED_BYTE.test(decoded)
    ) return null
    decodedSegments.push(decoded)
  }

  const relativePath = decodedSegments.join('/')
  const lineSuffix = lineSelection
    ? `#L${lineSelection.start}${lineSelection.end === lineSelection.start ? '' : `-L${lineSelection.end}`}`
    : ''
  const visiblePath = `${relativePath}${isDirectory ? '/' : ''}`
  return {
    source,
    relativePath,
    isDirectory,
    ...(lineSelection ? { lineSelection } : {}),
    protocolReference: value,
    copyText: `${visiblePath}${lineSuffix}`,
  }
}

function validLine(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_LINE_NUMBER
}

export function parseLegacySessionReference(value: string): ParsedThreadFileReference | null {
  const relativePath = normalizeThreadFilePathCandidate(value)
  if (!relativePath) return null
  return {
    source: 'legacy-session',
    relativePath,
    isDirectory: false,
    protocolReference: value,
    copyText: relativePath,
  }
}

/** Narrow historical heuristic. Do not broaden this to prose paths or extensionless names. */
export function normalizeThreadFilePathCandidate(value: string): string | null {
  const path = value.trim().replace(/\\/g, '/')
  if (!path || path.length > 512) return null
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return null
  if (path.startsWith('/') || path.startsWith('~')) return null
  if (path.includes('\0') || /[\r\n\t]/.test(path)) return null

  const segments = path.split('/').filter(Boolean)
  if (segments.length < 2) return null
  if (segments.some((segment) => segment === '.' || segment === '..')) return null
  if (!/\.[A-Za-z0-9]{1,12}$/.test(segments.at(-1) ?? '')) return null

  return segments.join('/')
}

export function stripFileReferenceProtocolFromMarkdown(text: string): string {
  const withoutInline = text.replace(/`(@(?:project|session)\/[^`]+)`/g, (full, reference: string) => {
    const parsed = parseThreadFileReference(reference)
    return parsed ? `\`${parsed.copyText}\`` : full
  })
  return withoutInline.replace(/\]\((@(?:project|session)\/[^)]+)\)/g, (full, reference: string) => {
    const parsed = parseThreadFileReference(reference, { markdownHref: true })
    return parsed ? `](${parsed.copyText.replace(/ /g, '%20')})` : full
  })
}
