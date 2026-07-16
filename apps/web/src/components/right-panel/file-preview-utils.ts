/** 预览支持的内联图片扩展名集合（用于判断是否走图片渲染分支） */
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'])

function imageExt(filePath: string): string | undefined {
  return /\.([a-z0-9]+)$/i.exec(filePath)?.[1]?.toLowerCase()
}

/** 是否为可内联预览的图片文件（按扩展名判断） */
export function isImageFile(filePath: string): boolean {
  const ext = imageExt(filePath)
  return ext !== undefined && IMAGE_EXTENSIONS.has(ext)
}

export type FilePreviewKind = 'text' | 'markdown' | 'image' | 'html' | 'unsupported'

const TEXT_EXTENSIONS = new Set([
  'txt', 'log', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'xml', 'csv',
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'css', 'scss', 'less',
  'py', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cpp', 'hpp',
  'sh', 'bash', 'zsh', 'ps1', 'sql', 'graphql', 'env.example',
])

const SOURCE_LANGUAGE_BY_EXTENSION: Record<string, string> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  py: 'python',
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  md: 'markdown',
  mdx: 'markdown',
  markdown: 'markdown',
  yml: 'yaml',
  jsonl: 'json',
  txt: 'text',
  log: 'text',
  csv: 'text',
}

const SOURCE_LANGUAGE_BY_FILENAME: Record<string, string> = {
  dockerfile: 'docker',
  makefile: 'makefile',
  readme: 'markdown',
  license: 'text',
}

export function getSourcePreviewLanguage(filePath: string): string {
  const filename = filePath.replace(/\\/g, '/').split('/').at(-1)?.toLowerCase() ?? ''
  const byFilename = SOURCE_LANGUAGE_BY_FILENAME[filename]
  if (byFilename) return byFilename
  const extension = imageExt(filename)
  return extension ? SOURCE_LANGUAGE_BY_EXTENSION[extension] ?? extension : 'text'
}

export function classifyFilePreview(filePath: string): FilePreviewKind {
  const extension = imageExt(filePath)
  if (extension && IMAGE_EXTENSIONS.has(extension)) return 'image'
  if (extension === 'md' || extension === 'mdx' || extension === 'markdown') return 'markdown'
  if (extension === 'html' || extension === 'htm') return 'html'
  if (extension && TEXT_EXTENSIONS.has(extension)) return 'text'
  if (!extension && /(^|\/)(README|LICENSE|Dockerfile|Makefile)$/i.test(filePath.replace(/\\/g, '/'))) return 'text'
  return 'unsupported'
}

export function isMissingFileError(error: unknown): boolean {
  const message = error instanceof Error
    ? error.message
    : error && typeof error === 'object' && 'message' in error
      ? String(error.message)
      : String(error)
  return /不存在|not found|ENOENT|no such file or directory/i.test(message)
}

export function createLatestPreviewRequestGuard() {
  let generation = 0
  return {
    begin() {
      generation += 1
      return generation
    },
    isCurrent(requestId: number) {
      return requestId === generation
    },
    cancel() {
      generation += 1
    },
  }
}

export type HtmlPreviewMessage = { kind: 'local' | 'remote'; href: string; scopeUrl: string }

const HTML_PREVIEW_LINK_EXTENSIONS = new Set([
  'html', 'htm', 'css', 'js', 'mjs', 'json',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico',
  'woff', 'woff2', 'ttf', 'otf', 'mp3', 'wav', 'ogg', 'mp4', 'webm',
])

export function parseHtmlPreviewMessage(value: unknown): HtmlPreviewMessage | null {
  if (!value || typeof value !== 'object') return null
  const message = value as Record<string, unknown>
  if (message.type !== 'lume-preview-link' || (message.kind !== 'local' && message.kind !== 'remote') || typeof message.href !== 'string' || typeof message.scopeUrl !== 'string') {
    return null
  }
  if (message.href.length === 0 || message.href.length > 4_096 || message.scopeUrl.length === 0 || message.scopeUrl.length > 4_096) return null
  if (message.kind === 'remote') {
    try {
      const protocol = new URL(message.href).protocol
      if (protocol !== 'http:' && protocol !== 'https:') return null
    } catch {
      return null
    }
  }
  return { kind: message.kind, href: message.href, scopeUrl: message.scopeUrl }
}

export function isHtmlPreviewMessageForScope(message: HtmlPreviewMessage, scopeUrl: string): boolean {
  try {
    const actual = new URL(message.scopeUrl)
    const expected = new URL(scopeUrl)
    return actual.protocol === 'lume-file:'
      && actual.host === 'preview'
      && actual.origin === expected.origin
      && actual.pathname === expected.pathname
      && actual.search === expected.search
  } catch {
    return false
  }
}

export function resolveHtmlPreviewLocalRef<T extends { source: 'project' | 'session' | 'memory' | 'legacy'; scopeId: string; relativePath: string }>(
  entry: T,
  href: string,
): T | null {
  try {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) return null
    const normalizedEntry = entry.relativePath.replace(/\\/g, '/').replace(/^\/+/, '')
    const directory = normalizedEntry.split('/').slice(0, -1).join('/')
    const base = new URL(`${directory ? `${directory}/` : ''}`, 'https://preview.invalid/')
    const target = new URL(href, base)
    const relativePath = decodeURIComponent(target.pathname).replace(/^\/+/, '')
    if (directory && relativePath !== directory && !relativePath.startsWith(`${directory}/`)) return null
    const parts = relativePath.split('/')
    if (!relativePath || parts.some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))) return null
    const extension = imageExt(relativePath)
    if (!extension || !HTML_PREVIEW_LINK_EXTENSIONS.has(extension)) return null
    return { ...entry, relativePath }
  } catch {
    return null
  }
}

export function createPreviewLinkRateLimiter(input: {
  max: number
  windowMs: number
  now?: () => number
}) {
  const now = input.now ?? Date.now
  let requests: number[] = []
  return {
    allow() {
      const cutoff = now() - input.windowMs
      requests = requests.filter((timestamp) => timestamp > cutoff)
      if (requests.length >= input.max) return false
      requests.push(now())
      return true
    },
  }
}

/**
 * 构造 lume-file:// 协议 URL，交由 Electron main 流式读取并交 Chromium 解码。
 * 仅适用于 .lume/agent-workspaces 可信根内的文件（thread/workspace）。
 */
export function lumeFileUrl(absPath: string): string {
  return `lume-file://file/${encodeURIComponent(absPath)}`
}
