import { randomBytes } from 'node:crypto'
import { closeSync, createReadStream, existsSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { Readable } from 'node:stream'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

interface PreviewEntryRef {
  source: 'project' | 'session' | 'memory' | 'legacy'
  scopeId: string
  relativePath: string
}

interface PreviewGuardedRef {
  ref: PreviewEntryRef
  guard: Record<string, unknown>
}

export const PREVIEW_PROTOCOL_MAX_MEDIA_BYTES = 50 * 1024 * 1024

export type PreviewScopeKind = 'html-directory' | 'media-file'

export interface PreviewScope {
  token: string
  kind: PreviewScopeKind
  ownerWebContentsId: number
  entryRef?: PreviewEntryRef
  guardedRef?: PreviewGuardedRef
  entryPath: string
  rootPath: string
  generation: number
  expiresAt: number
}

export interface PreviewScopeRegistry {
  create(input: {
    kind: PreviewScopeKind
    ownerWebContentsId: number
    entryRef?: PreviewEntryRef
    guardedRef?: PreviewGuardedRef
    absolutePath: string
    generation?: number
    ttlMs?: number
  }): PreviewScope
  get(token: string): PreviewScope | null
  owns(token: string, webContentsId: number): boolean
  revoke(token: string): void
  revokeOwner(webContentsId: number): void
}

export function createPreviewScopeRegistry(options: { now?: () => number } = {}): PreviewScopeRegistry {
  const now = options.now ?? Date.now
  const scopes = new Map<string, PreviewScope>()
  const get = (token: string): PreviewScope | null => {
    const scope = scopes.get(token)
    if (!scope) return null
    if (scope.expiresAt <= now()) {
      scopes.delete(token)
      return null
    }
    return scope
  }
  return {
    create(input) {
      const entryPath = realpathSync(resolve(input.absolutePath))
      if (!statSync(entryPath).isFile()) throw new Error('Preview entry must be a regular file')
      const rootPath = input.kind === 'html-directory' ? realpathSync(dirname(entryPath)) : dirname(entryPath)
      const token = randomBytes(32).toString('hex')
      const scope: PreviewScope = {
        token,
        kind: input.kind,
        ownerWebContentsId: input.ownerWebContentsId,
        ...(input.entryRef ? { entryRef: input.entryRef } : {}),
        ...(input.guardedRef ? { guardedRef: input.guardedRef } : {}),
        entryPath,
        rootPath,
        generation: input.generation ?? 0,
        expiresAt: now() + (input.ttlMs ?? 5 * 60_000),
      }
      scopes.set(token, scope)
      return scope
    },
    get,
    owns(token, webContentsId) {
      return get(token)?.ownerWebContentsId === webContentsId
    },
    revoke(token) {
      scopes.delete(token)
    },
    revokeOwner(webContentsId) {
      for (const [token, scope] of scopes) {
        if (scope.ownerWebContentsId === webContentsId) scopes.delete(token)
      }
    },
  }
}

const HTML_ASSET_EXTENSIONS = new Set([
  '.html', '.htm', '.css', '.js', '.mjs', '.json',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico',
  '.woff', '.woff2', '.ttf', '.otf',
  '.mp3', '.wav', '.ogg', '.mp4', '.webm',
])

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/x-m4v',
  '.pdf': 'application/pdf',
  '.csv': 'text/csv; charset=utf-8',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

const MEDIA_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg',
  '.pdf', '.mp4', '.webm', '.mov', '.m4v',
  '.csv', '.docx', '.xlsx', '.pptx',
])

export type PreviewProtocolResolution =
  | { kind: 'forbidden' }
  | { kind: 'notfound' }
  | { kind: 'too-large' }
  | {
    kind: 'ok'
    path: string
    method: 'GET' | 'HEAD' | 'OPTIONS'
    status: 200
    mimeType: string
    size: number
    headers: Record<string, string>
    maxBytes: number
  }

export function resolvePreviewProtocolRequest(
  registry: PreviewScopeRegistry,
  url: string,
  method: string,
): PreviewProtocolResolution {
  try {
    if (/%(?:00|2e|2f|5c)/i.test(url)) return { kind: 'forbidden' }
    const parsed = new URL(url)
    if (parsed.protocol !== 'lume-file:' || parsed.host !== 'preview') return { kind: 'forbidden' }
    const requestMethod = method.toUpperCase()
    if (requestMethod !== 'GET' && requestMethod !== 'HEAD' && requestMethod !== 'OPTIONS') return { kind: 'forbidden' }
    const segments = parsed.pathname.split('/').filter(Boolean).map((segment) => decodeURIComponent(segment))
    const token = segments.shift()
    if (!token) return { kind: 'forbidden' }
    const scope = registry.get(token)
    if (!scope) return { kind: 'forbidden' }
    if (segments.length === 0 || segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.startsWith('.') || segment.includes('\0'))) {
      return { kind: 'forbidden' }
    }
    const requestedRelative = segments.join('/')
    if (isAbsolute(requestedRelative)) return { kind: 'forbidden' }
    const extension = extname(requestedRelative).toLowerCase()
    if (!extension) return { kind: 'forbidden' }
    const candidate = resolve(scope.rootPath, requestedRelative)
    if (!isInsideOrEqual(candidate, scope.rootPath) || !existsSync(candidate)) return { kind: 'notfound' }
    let cursor = scope.rootPath
    for (const segment of segments) {
      cursor = join(cursor, segment)
      if (lstatSync(cursor).isSymbolicLink()) return { kind: 'forbidden' }
    }
    const real = realpathSync(candidate)
    if (!isInsideOrEqual(real, scope.rootPath)) return { kind: 'forbidden' }
    const metadata = statSync(real)
    if (!metadata.isFile()) return { kind: 'notfound' }

    if (scope.kind === 'media-file') {
      if (real !== scope.entryPath || basename(real) !== basename(requestedRelative) || !MEDIA_EXTENSIONS.has(extension)) {
        return { kind: 'forbidden' }
      }
      if (metadata.size > PREVIEW_PROTOCOL_MAX_MEDIA_BYTES) return { kind: 'too-large' }
    } else if (!HTML_ASSET_EXTENSIONS.has(extension)) {
      return { kind: 'forbidden' }
    }

    const headers: Record<string, string> = {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...(scope.kind === 'html-directory' ? { 'Access-Control-Allow-Origin': '*' } : { 'Accept-Ranges': 'bytes' }),
    }
    return {
      kind: 'ok',
      path: real,
      method: requestMethod,
      status: 200,
      mimeType: MIME_TYPES[extension] ?? 'application/octet-stream',
      size: metadata.size,
      headers,
      maxBytes: PREVIEW_PROTOCOL_MAX_MEDIA_BYTES,
    }
  } catch {
    return { kind: 'forbidden' }
  }
}

export function previewScopeUrl(scope: PreviewScope): string {
  return `lume-file://preview/${scope.token}/${encodeURIComponent(basename(scope.entryPath))}`
}

export function isAllowedPreviewFrameNavigation(
  registry: PreviewScopeRegistry,
  url: string,
  ownerWebContentsId: number,
): boolean {
  const token = previewTokenFromUrl(url)
  if (!token || !registry.owns(token, ownerWebContentsId)) return false
  const scope = registry.get(token)
  if (!scope || scope.kind !== 'html-directory') return false
  try {
    const target = new URL(url)
    const entry = new URL(previewScopeUrl(scope))
    return target.origin === entry.origin && target.pathname === entry.pathname && target.search === entry.search
  } catch {
    return false
  }
}

export async function createPreviewProtocolResponse(
  registry: PreviewScopeRegistry,
  request: Pick<Request, 'url' | 'method' | 'headers'>,
): Promise<Response> {
  const resolution = resolvePreviewProtocolRequest(registry, request.url, request.method)
  if (resolution.kind === 'forbidden') return new Response('Forbidden', { status: 403 })
  if (resolution.kind === 'notfound') return new Response('Not Found', { status: 404 })
  if (resolution.kind === 'too-large') return new Response('Preview file is too large', { status: 413 })
  const headers = new Headers(resolution.headers)
  headers.set('Content-Type', resolution.mimeType)
  if (resolution.method === 'OPTIONS') return new Response(null, { status: 204, headers })
  if (resolution.mimeType.startsWith('text/html')) {
    if (resolution.method === 'HEAD') {
      headers.set('Content-Length', String(resolution.size))
      return new Response(null, { status: 200, headers })
    }
    const html = injectHtmlNavigationBridge(readFileSync(resolution.path, 'utf8'))
    headers.set('Content-Length', String(Buffer.byteLength(html)))
    return new Response(html, { status: 200, headers })
  }

  const descriptor = openSync(resolution.path, 'r')
  let metadata
  try {
    metadata = fstatSync(descriptor)
    if (!metadata.isFile()) throw new Error('Preview target is not a regular file')
    if (metadata.size > resolution.maxBytes) {
      closeSync(descriptor)
      return new Response('Preview file is too large', { status: 413, headers })
    }
  } catch (error) {
    try { closeSync(descriptor) } catch { /* already closed */ }
    throw error
  }
  const rangeHeader = resolution.headers['Accept-Ranges'] ? request.headers.get('range') : null
  const range = rangeHeader ? parseSingleRange(rangeHeader, metadata.size) : null
  if (rangeHeader && !range) {
    closeSync(descriptor)
    headers.set('Content-Range', `bytes */${metadata.size}`)
    return new Response(null, { status: 416, headers })
  }
  const start = range?.start ?? 0
  const end = range?.end ?? metadata.size - 1
  headers.set('Content-Length', String(Math.max(0, end - start + 1)))
  if (range) headers.set('Content-Range', `bytes ${start}-${end}/${metadata.size}`)
  if (resolution.method === 'HEAD') {
    closeSync(descriptor)
    return new Response(null, { status: range ? 206 : 200, headers })
  }
  if (metadata.size === 0) {
    closeSync(descriptor)
    return new Response(null, { status: 200, headers })
  }
  const stream = createReadStream(resolution.path, { fd: descriptor, autoClose: true, start, end })
  let streamed = 0
  stream.on('data', (chunk) => {
    streamed += chunk.length
    let currentSize = 0
    try { currentSize = fstatSync(descriptor).size } catch { currentSize = resolution.maxBytes + 1 }
    if (streamed > resolution.maxBytes || currentSize > resolution.maxBytes) {
      stream.destroy(new Error('Preview stream exceeded byte limit'))
    }
  })
  return new Response(Readable.toWeb(stream) as ReadableStream, { status: range ? 206 : 200, headers })
}

export function injectHtmlNavigationBridge(html: string): string {
  const bridge = `<script>(()=>{document.addEventListener('click',(event)=>{const anchor=event.target instanceof Element?event.target.closest('a[href]'):null;if(!anchor)return;const href=anchor.getAttribute('href');if(!href||href.startsWith('#'))return;event.preventDefault();let kind='local';try{const url=new URL(href,location.href);if(url.protocol==='http:'||url.protocol==='https:')kind='remote';else if(url.protocol!=='lume-file:')return;}catch{return;}parent.postMessage({type:'lume-preview-link',kind,href,scopeUrl:location.href},'*');},{capture:true});})();</script>`
  const headEnd = html.search(/<\/head\s*>/i)
  return headEnd >= 0 ? `${html.slice(0, headEnd)}${bridge}${html.slice(headEnd)}` : `${bridge}${html}`
}

export function previewTokenFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'lume-file:' || parsed.host !== 'preview') return null
    return parsed.pathname.split('/').filter(Boolean)[0] ?? null
  } catch {
    return null
  }
}

export function parseSingleRange(value: string | null | undefined, size: number): { start: number; end: number } | null {
  if (!value || !/^bytes=\d*-\d*$/.test(value) || value.includes(',')) return null
  const [startText, endText] = value.slice('bytes='.length).split('-')
  if (!startText && !endText) return null
  if (!startText) {
    const suffix = Number(endText)
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(startText)
  const requestedEnd = endText ? Number(endText) : size - 1
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start < 0 || start >= size || requestedEnd < start) return null
  return { start, end: Math.min(requestedEnd, size - 1) }
}

function isInsideOrEqual(candidate: string, root: string): boolean {
  const rel = relative(realpathSync(root), candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}
