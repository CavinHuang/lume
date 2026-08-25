/**
 * FileReadTool - Read file contents with line numbers
 */

import { readFile, stat } from 'fs/promises'
import { extname } from 'path'
import { defineTool } from './types.js'
import { ensurePathAllowed, getUnsafeFilePathReason, resolveInputPath, suggestNearbyPaths } from '../utils/pathing.js'
import { isNativeAvailable, nativeSummarize } from '@lume/natives'
import { readTextFile, readTextFileRange } from '../utils/text-file.js'
import { estimateTokens } from '../utils/tokens.js'
import type { ToolContext } from '../types.js'

const SUMMARIZABLE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.rs', '.py', '.go',
  '.c', '.h',
  '.html', '.htm', '.css', '.scss',
  '.json', '.yaml', '.yml', '.toml',
  '.sh', '.bash', '.md',
])
const SUMMARIZE_THRESHOLD_LINES = 500
const MAX_MULTIMODAL_BYTES = 20 * 1024 * 1024
const DEFAULT_MAX_TEXT_BYTES = 1024 * 1024
const DEFAULT_MAX_TEXT_TOKENS = 25_000
const MAX_PDF_TEXT_PREVIEW = 50_000
const MAX_PDF_PAGES = 20
const IMAGE_MEDIA_TYPES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
])
const IMAGE_METADATA_ONLY_EXTENSIONS = new Set(['.bmp', '.svg'])
const BINARY_EXTENSIONS = new Set([
  '.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.rar', '.jar',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.dat', '.wasm',
  '.db', '.sqlite', '.sqlite3',
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp',
  '.mp3', '.mp4', '.mov', '.avi', '.mkv', '.wav', '.flac', '.ogg', '.webm',
  '.woff', '.woff2', '.ttf', '.otf',
])
type ReadResult = { data: unknown; is_error?: boolean; _meta?: Record<string, unknown> }

export const FileReadTool = defineTool({
  name: 'Read',
  description: 'Read text, images, PDFs, and Jupyter notebooks from the filesystem. For code, prefer this basic tool over Node REPL or shell scripts. Text uses 0-based line offsets; use offset/limit for large files. PDF pages are 1-based ranges such as "1-3".',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'The absolute path to the file to read',
      },
      offset: {
        type: 'number',
        description: 'Line number to start reading from (0-based)',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of lines to read',
      },
      pages: {
        type: 'string',
        description: 'PDF pages to read, using 1-based ranges such as "1-3,5"',
      },
    },
    required: ['file_path'],
  },
  isReadOnly: true,
  isConcurrencySafe: true,
  validateInput(input) {
    if (!input || typeof input !== 'object') return 'Input must be an object.'
    if (typeof input.file_path !== 'string' || !input.file_path.trim()) return 'file_path is required.'
    for (const key of ['offset', 'limit']) {
      if (input[key] !== undefined && (!Number.isInteger(input[key]) || input[key] < 0)) {
        return `${key} must be a non-negative integer.`
      }
    }
    if (input.pages !== undefined && (typeof input.pages !== 'string' || !input.pages.trim())) {
      return 'pages must be a non-empty page range string.'
    }
    if (typeof input.pages === 'string') {
      try {
        parsePageRanges(input.pages)
      } catch (error: any) {
        return error.message
      }
    }
  },
  getPath(input, context) {
    return resolveInputPath(context.cwd, input.file_path, context.additionalDirectories)
  },
  async call(input, context) {
    const unsafePathReason = getUnsafeFilePathReason(input.file_path)
    if (unsafePathReason) return { data: `Error: ${unsafePathReason}`, is_error: true }
    const filePath = await resolveInputPath(
      context.cwd,
      input.file_path,
      context.additionalDirectories,
    )
    const sandboxError = ensurePathAllowed(
      filePath,
      'read',
      context.sandbox,
      context.additionalDirectories,
    )
    if (sandboxError) {
      return { data: sandboxError, is_error: true }
    }

    try {
      if (context.abortSignal?.aborted) throw new DOMException('Operation aborted', 'AbortError')
      const fileStat = await stat(filePath)
      if (fileStat.isDirectory()) {
        return { data: `Error: ${filePath} is a directory, not a file. Use Bash with 'ls' to list directory contents.`, is_error: true }
      }

      const ext = extname(filePath).toLowerCase()
      if (IMAGE_MEDIA_TYPES.has(ext)) {
        return await readImage(filePath, fileStat.size, ext, context.abortSignal)
      }
      if (IMAGE_METADATA_ONLY_EXTENSIONS.has(ext)) {
        return {
          data: `[Image file: ${filePath} (${fileStat.size} bytes). ${ext === '.svg' ? 'SVG' : 'BMP'} is not a provider-compatible image content block.]`,
          _meta: { read: { kind: 'image', filePath, size: fileStat.size, multimodal: false } },
        }
      }
      if (ext === '.pdf') {
        return await readPdf(filePath, fileStat.size, input.pages, context.abortSignal)
      }
      if (ext === '.ipynb') {
        return await readNotebook(filePath, fileStat.mtimeMs, fileStat.size, input.offset, input.limit, context)
      }
      if (BINARY_EXTENSIONS.has(ext)) {
        return {
          data: `Error: Cannot read binary file as text: ${filePath}. Use a format-specific tool or Bash to inspect it.`,
          is_error: true,
          _meta: { read: { kind: 'binary', filePath, size: fileStat.size, multimodal: false } },
        }
      }

      const hasExplicitRange = input.offset !== undefined || input.limit !== undefined
      const offset = input.offset ?? 0
      const limit = input.limit ?? (hasExplicitRange ? 2000 : SUMMARIZE_THRESHOLD_LINES)
      if (isUnchangedRead(context.fileStateCache?.get(filePath), fileStat.mtimeMs, fileStat.size, offset, limit)) {
        return unchangedResult(filePath)
      }
      const shouldReadWholeFile = !hasExplicitRange && SUMMARIZABLE_EXTENSIONS.has(ext)
      if (!shouldReadWholeFile) {
        const ranged = await readTextFileRange(filePath, offset, limit, context.abortSignal)
        const textLimitError = validateTextLimits(ranged.content, filePath, context)
        if (textLimitError) return textLimitError
        // truncated 时窗口凑满提前停读，totalLines 只是下界：
        // 强制 partial 视图，且不谎报精确的 remainingLines（#314）。
        const isPartialView = hasExplicitRange || offset > 0 || ranged.truncated
        context.fileStateCache?.set(filePath, {
          content: ranged.content,
          timestamp: fileStat.mtimeMs,
          size: fileStat.size,
          offset,
          limit,
          isPartialView,
        })
        return {
          data: {
            filePath,
            // 行尾换行已忠实入缓存（#569），显示前去掉以免多出幽灵空行。
            content: ranged.content
              ? ranged.content.replace(/\n$/, '').split('\n').map((line, i) => `${offset + i + 1}\t${line}`).join('\n')
              : '(empty file)',
            offset,
            limit,
            totalLines: ranged.totalLines,
            ...(ranged.truncated ? {} : { remainingLines: Math.max(0, ranged.totalLines - offset - limit) }),
          },
          _meta: {
            read: {
              offset,
              limit,
              totalLines: ranged.totalLines,
              partial: isPartialView,
              summarized: false,
              ...(ranged.truncated ? { truncated: true } : {}),
            },
          },
        }
      }

      // Reject oversized whole-file reads before loading them into memory.
      const maxBytes = configuredPositiveNumber(context, 'readMaxBytes', DEFAULT_MAX_TEXT_BYTES)
      if (fileStat.size > maxBytes) {
        return {
          data: `Error: Read output for ${filePath} is ${fileStat.size} bytes, exceeding the ${maxBytes}-byte limit. Use offset and limit to read a smaller range.`,
          is_error: true,
          _meta: { read: { filePath, truncated: false, bytes: fileStat.size, maxBytes } },
        }
      }

      const textFile = await readTextFile(filePath)
      if (context.abortSignal?.aborted) throw new DOMException('Operation aborted', 'AbortError')
      const content = textFile.content
      const lines = content.length === 0 ? [] : content.split('\n')

      // If user specified offset/limit, always return raw content (explicit read)
      if (
        !hasExplicitRange
        && lines.length > SUMMARIZE_THRESHOLD_LINES
        && isNativeAvailable()
        && SUMMARIZABLE_EXTENSIONS.has(ext)
      ) {
        const summary = nativeSummarize({
          code: content,
          path: filePath,
          min_body_lines: 4,
          min_comment_lines: 6,
          unfold_until_lines: 200,
        })

        if (summary && summary.parsed && summary.segments.length > 0) {
          const keptSegments: string[] = []
          let keptLines = 0
          for (const segment of summary.segments) {
            if (segment.kind === 'kept' && segment.text) {
              keptSegments.push(segment.text)
              keptLines += segment.text.split('\n').length
              continue
            }
            if (segment.kind === 'elided') {
              const lineCount = segment.endLine - segment.startLine + 1
              keptSegments.push(`/* ... ${lineCount} lines elided (lines ${segment.startLine}-${segment.endLine}) ... */`)
            }
          }

          const summarizedContent = keptSegments.join('\n')
          const summaryLimitError = validateTextLimits(summarizedContent, filePath, context)
          if (summaryLimitError) return summaryLimitError

          context.fileStateCache?.set(filePath, {
            content,
            timestamp: fileStat.mtimeMs,
            size: fileStat.size,
            offset,
            limit,
            isPartialView: true,
          })

          return {
            data: {
              filePath,
              content: summarizedContent,
              totalLines: lines.length,
              summarized: true,
              keptLines,
              language: summary.language,
            },
            _meta: { read: { offset: 0, limit: lines.length, totalLines: lines.length, partial: true, summarized: true } },
          }
        }
      }

      // Default: return raw content with line numbers
      const selectedLines = lines.slice(offset, offset + limit)
      const isPartialView = offset > 0 || offset + limit < lines.length || hasExplicitRange
      const textLimitError = validateTextLimits(selectedLines.join('\n'), filePath, context)
      if (textLimitError) return textLimitError

      context.fileStateCache?.set(filePath, {
        content: isPartialView ? selectedLines.join('\n') : content,
        timestamp: fileStat.mtimeMs,
        size: fileStat.size,
        offset,
        limit,
        isPartialView,
      })

      // Format with line numbers (cat -n style)
      const numbered = selectedLines.map((line: string, i: number) => {
        const lineNum = offset + i + 1
        return `${lineNum}\t${line}`
      }).join('\n')

      return {
        data: {
          filePath,
          content: numbered || '(empty file)',
          offset,
          limit,
          totalLines: lines.length,
          remainingLines: Math.max(0, lines.length - offset - limit),
        },
        _meta: { read: { offset, limit, totalLines: lines.length, partial: isPartialView, summarized: false } },
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') return { data: 'Read aborted.', is_error: true }
      if (err.code === 'ENOENT') {
        const suggestions = await suggestNearbyPaths(filePath)
        return {
          data: `Error: File not found: ${filePath}${suggestions.length ? `\nSimilar paths:\n${suggestions.map((item) => `- ${item}`).join('\n')}` : ''}`,
          is_error: true,
        }
      }
      return { data: `Error reading file: ${err.message}`, is_error: true }
    }
  },
})

async function readImage(
  filePath: string,
  fileSize: number,
  extension: string,
  signal?: AbortSignal,
): Promise<ReadResult> {
  if (fileSize > MAX_MULTIMODAL_BYTES) {
    return { data: `Error: Image is too large to send to the model (${fileSize} bytes; maximum is ${MAX_MULTIMODAL_BYTES} bytes).`, is_error: true }
  }
  throwIfAborted(signal)
  const bytes = await readFile(filePath)
  throwIfAborted(signal)
  if (bytes.byteLength > MAX_MULTIMODAL_BYTES) {
    return { data: `Error: Image changed while reading and is now too large to send to the model (${bytes.byteLength} bytes).`, is_error: true }
  }
  const mediaType = IMAGE_MEDIA_TYPES.get(extension) ?? 'application/octet-stream'
  const dimensions = getImageDimensions(bytes, extension)
  const dimensionText = dimensions ? `, ${dimensions.width}x${dimensions.height}` : ''
  return {
    data: {
      content: [
        { type: 'text', text: `[Image file: ${filePath} (${bytes.byteLength} bytes${dimensionText})]` },
        {
          type: 'image',
          source: { type: 'base64', media_type: mediaType, data: bytes.toString('base64') },
        },
      ],
    },
    _meta: { read: { kind: 'image', filePath, mediaType, size: bytes.byteLength, ...(dimensions ? { dimensions } : {}), multimodal: true } },
  }
}

async function readPdf(
  filePath: string,
  fileSize: number,
  pageSpec: unknown,
  signal?: AbortSignal,
): Promise<ReadResult> {
  if (fileSize > MAX_MULTIMODAL_BYTES) {
    return { data: `Error: PDF is too large to send to the model (${fileSize} bytes; maximum is ${MAX_MULTIMODAL_BYTES} bytes).`, is_error: true }
  }
  throwIfAborted(signal)
  const bytes = await readFile(filePath)
  throwIfAborted(signal)
  if (bytes.byteLength > MAX_MULTIMODAL_BYTES) {
    return { data: `Error: PDF changed while reading and is now too large to send to the model (${bytes.byteLength} bytes).`, is_error: true }
  }
  const mupdf = await import('mupdf')
  const document = mupdf.Document.openDocument(Buffer.from(bytes), 'application/pdf')
  try {
    const totalPages = document.countPages()
    const selectedPages = pageSpec === undefined
      ? undefined
      : parsePageRanges(String(pageSpec))

    if (!selectedPages) {
      if (totalPages > MAX_PDF_PAGES) {
        return {
          data: `Error: This PDF has ${totalPages} pages. Use the pages parameter to read a range (for example, pages: "1-5"). Maximum ${MAX_PDF_PAGES} pages per request.`,
          is_error: true,
        }
      }
      const textPreview: string[] = []
      for (let pageIndex = 0; pageIndex < Math.min(totalPages, 100); pageIndex++) {
        throwIfAborted(signal)
        try {
          const page = document.loadPage(pageIndex)
          const text = page.toStructuredText().asText().trim()
          page.destroy()
          if (text) textPreview.push(text)
        } catch {
          // Image-only or malformed pages can still be sent as a PDF document.
        }
        if (textPreview.join('\n\n').length >= MAX_PDF_TEXT_PREVIEW) break
      }
      const preview = textPreview.join('\n\n').slice(0, MAX_PDF_TEXT_PREVIEW)
      return {
        data: {
          content: [
            {
              type: 'text',
              text: `[PDF file: ${filePath} (${totalPages} page${totalPages === 1 ? '' : 's'})]${preview ? `\n\n${preview}` : ''}`,
            },
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: bytes.toString('base64') },
            },
          ],
        },
        _meta: { read: { kind: 'pdf', filePath, size: bytes.byteLength, totalPages, multimodal: true } },
      }
    }

    if (selectedPages.length > MAX_PDF_PAGES) {
      return { data: `Error: PDF page selection contains ${selectedPages.length} pages; maximum is ${MAX_PDF_PAGES}.`, is_error: true }
    }
    const invalidPage = selectedPages.find((page) => page >= totalPages)
    if (invalidPage !== undefined) {
      return { data: `Error: PDF page ${invalidPage + 1} is outside the document (1-${totalPages}).`, is_error: true }
    }

    const content: Array<Record<string, unknown>> = [
      { type: 'text', text: `[PDF pages ${selectedPages.map((page) => page + 1).join(', ')} from ${filePath}]` },
    ]
    for (const pageIndex of selectedPages) {
      throwIfAborted(signal)
      const page = document.loadPage(pageIndex)
      const pixmap = page.toPixmap(mupdf.Matrix.scale(1.5, 1.5), mupdf.ColorSpace.DeviceRGB, false, false)
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: Buffer.from(pixmap.asPNG()).toString('base64') },
        _meta: { page: pageIndex + 1 },
      })
      pixmap.destroy()
      page.destroy()
    }
    return {
      data: { content },
      _meta: { read: { kind: 'pdf', filePath, size: bytes.byteLength, totalPages, pages: selectedPages.map((page) => page + 1), multimodal: true } },
    }
  } finally {
    // mupdf documents/pages/pixmaps live in a WASM heap; destroy or every Read
    // of a PDF permanently grows sidecar memory (#245)
    document.destroy()
  }
}

async function readNotebook(
  filePath: string,
  timestamp: number,
  size: number,
  offsetInput: unknown,
  limitInput: unknown,
  context: ToolContext,
): Promise<ReadResult> {
  const textFile = await readTextFile(filePath)
  throwIfAborted(context.abortSignal)
  let notebook: any
  try {
    notebook = JSON.parse(textFile.content)
  } catch {
    return { data: `Error: Invalid JSON in notebook: ${filePath}`, is_error: true }
  }
  if (!notebook || !Array.isArray(notebook.cells)) {
    return { data: `Error: Notebook must contain a cells array: ${filePath}`, is_error: true }
  }

  const hasExplicitRange = offsetInput !== undefined || limitInput !== undefined
  const offset = Number(offsetInput ?? 0)
  const limit = Number(limitInput ?? notebook.cells.length)
  if (isUnchangedRead(context.fileStateCache?.get(filePath), timestamp, size, offset, limit)) {
    return unchangedResult(filePath)
  }
  const cells = hasExplicitRange ? notebook.cells.slice(offset, offset + limit) : notebook.cells
  const partial = hasExplicitRange || offset > 0 || cells.length < notebook.cells.length
  const notebookContent = JSON.stringify({ type: 'notebook', file: { filePath, cells } }, null, 2)
  const textLimitError = validateTextLimits(notebookContent, filePath, context)
  if (textLimitError) return textLimitError
  context.fileStateCache?.set(filePath, {
    content: textFile.content,
    timestamp,
    size,
    ...(partial ? { offset, limit } : {}),
    isPartialView: partial,
  })

  return {
    data: {
      content: notebookContent,
    },
    _meta: {
      read: { kind: 'notebook', filePath, offset, limit, totalCells: notebook.cells.length, partial, summarized: false },
    },
  }
}

function parsePageRanges(value: string): number[] {
  const pages = new Set<number>()
  for (const part of value.split(',')) {
    const trimmed = part.trim()
    const match = /^(\d+)(?:-(\d+))?$/.exec(trimmed)
    if (!match) throw new Error('pages must use 1-based ranges such as "1-3,5".')
    const start = Number(match[1])
    const end = Number(match[2] ?? match[1])
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) {
      throw new Error('pages must contain valid ascending 1-based ranges.')
    }
    if (end - start + 1 > MAX_PDF_PAGES) {
      throw new Error(`pages selection cannot exceed ${MAX_PDF_PAGES} pages.`)
    }
    for (let page = start; page <= end; page++) pages.add(page - 1)
    if (pages.size > MAX_PDF_PAGES) throw new Error(`pages selection cannot exceed ${MAX_PDF_PAGES} pages.`)
  }
  return [...pages].sort((a, b) => a - b)
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  const error = new Error('Operation aborted')
  error.name = 'AbortError'
  throw error
}

function isUnchangedRead(
  state: { timestamp: number; size?: number; offset?: number; limit?: number } | undefined,
  timestamp: number,
  size: number,
  offset: number,
  limit: number | undefined,
): boolean {
  return !!state
    && state.timestamp === timestamp
    && (state.size === undefined || state.size === size)
    && state.offset === offset
    && state.limit === limit
}

function unchangedResult(filePath: string): ReadResult {
  return {
    data: `File unchanged since it was last read: ${filePath}`,
    _meta: { read: { filePath, unchanged: true } },
  }
}

function validateTextLimits(content: string, filePath: string, context: ToolContext): ReadResult | undefined {
  const maxBytes = configuredPositiveNumber(context, 'readMaxBytes', DEFAULT_MAX_TEXT_BYTES)
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > maxBytes) {
    return {
      data: `Error: Read output for ${filePath} is ${bytes} bytes, exceeding the ${maxBytes}-byte limit. Use offset and limit to read a smaller range.`,
      is_error: true,
      _meta: { read: { filePath, truncated: false, bytes, maxBytes } },
    }
  }

  const maxTokens = configuredPositiveNumber(context, 'readMaxTokens', DEFAULT_MAX_TEXT_TOKENS)
  const tokens = estimateTokens(content)
  if (tokens > maxTokens) {
    return {
      data: `Error: Read output for ${filePath} is approximately ${tokens} tokens, exceeding the ${maxTokens}-token limit. Use offset and limit to read a smaller range.`,
      is_error: true,
      _meta: { read: { filePath, truncated: false, bytes, tokens, maxTokens } },
    }
  }
  return undefined
}

function configuredPositiveNumber(context: ToolContext, key: string, fallback: number): number {
  const value = context.toolConfig?.[key]
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback
}

function getImageDimensions(bytes: Uint8Array, extension: string): { width: number; height: number } | undefined {
  const input = Buffer.from(bytes)
  if (extension === '.png' && input.length >= 24 && input.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { width: input.readUInt32BE(16), height: input.readUInt32BE(20) }
  }
  if ((extension === '.gif') && input.length >= 10 && input.subarray(0, 6).toString('ascii').startsWith('GIF')) {
    return { width: input.readUInt16LE(6), height: input.readUInt16LE(8) }
  }
  if (extension === '.webp' && input.length >= 30 && input.subarray(0, 4).toString('ascii') === 'RIFF' && input.subarray(8, 12).toString('ascii') === 'WEBP') {
    if (input.subarray(12, 16).toString('ascii') === 'VP8X') {
      return {
        width: 1 + (input[24] ?? 0) + ((input[25] ?? 0) << 8) + ((input[26] ?? 0) << 16),
        height: 1 + (input[27] ?? 0) + ((input[28] ?? 0) << 8) + ((input[29] ?? 0) << 16),
      }
    }
  }
  if (extension === '.jpg' || extension === '.jpeg') {
    return getJpegDimensions(input)
  }
  return undefined
}

function getJpegDimensions(input: Buffer): { width: number; height: number } | undefined {
  if (input.length < 4 || input[0] !== 0xff || input[1] !== 0xd8) return undefined
  let offset = 2
  while (offset + 9 < input.length) {
    if (input[offset] !== 0xff) {
      offset++
      continue
    }
    while (input[offset] === 0xff) offset++
    const marker = input[offset++] ?? 0
    if (marker === 0xd8 || marker === 0xd9) continue
    if (offset + 1 >= input.length) break
    const segmentLength = input.readUInt16BE(offset)
    if (segmentLength < 2 || offset + segmentLength > input.length) break
    const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)
    if (isStartOfFrame && segmentLength >= 7) {
      return { width: input.readUInt16BE(offset + 5), height: input.readUInt16BE(offset + 3) }
    }
    offset += segmentLength
  }
  return undefined
}
