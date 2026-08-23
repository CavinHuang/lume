import { mkdir, readFile, readdir, rm, stat } from 'fs/promises'
import { dirname, join, normalize, resolve } from 'path'
import { decodeTextFile, encodeTextFile } from './text-file.js'
import { writeFileAtomic } from './fs-atomic.js'

export interface FileSnapshot {
  path: string
  existed: boolean
  content?: string
  mtimeMs?: number
  encoding?: 'utf8' | 'utf16le'
  lineEnding?: 'CRLF' | 'LF' | 'CR'
  bom?: boolean
  contentBase64?: string
  unsupported?: boolean
}

export interface FileCheckpoint {
  userMessageId: string
  createdAt: string
  files: Record<string, FileSnapshot>
}

export type FileCheckpointState = Record<string, FileCheckpoint>

// Workspace scans repeat for every qualifying tool call within one user
// message. Cache the last collected path list so only the first call walks
// the directory tree; later calls reuse it and dedupe against captured files.
// Single-entry (last key wins) so a growing session does not accumulate scans.
const workspaceScanCache = new WeakMap<FileCheckpointState, { key: string; paths: string[] }>()

const WORKSPACE_CHECKPOINT_EXCLUDED_DIRECTORIES = new Set([
  '.git', 'node_modules', '.next', '.turbo', '.cache', 'dist', 'build', 'coverage', 'out', 'artifacts', 'files', 'plans', '.context'
])

export async function captureWorkspaceFileSnapshots(
  state: FileCheckpointState,
  userMessageId: string,
  roots: string[],
  options: { maxFiles?: number; maxFileSizeBytes?: number; maxTotalBytes?: number } = {},
): Promise<FileCheckpoint | null> {
  const maxFiles = options.maxFiles ?? 10_000
  const maxFileSizeBytes = options.maxFileSizeBytes ?? 4 * 1024 * 1024
  const maxTotalBytes = options.maxTotalBytes ?? 64 * 1024 * 1024
  const cacheKey = `${userMessageId} ${JSON.stringify(roots)}`
  const cached = workspaceScanCache.get(state)
  let paths: string[]
  if (cached && cached.key === cacheKey) {
    paths = cached.paths
  } else {
    paths = []
    for (const root of roots) {
      await collectWorkspaceFiles(resolve(root), paths, maxFiles)
      if (paths.length >= maxFiles) break
    }
    workspaceScanCache.set(state, { key: cacheKey, paths })
  }
  const checkpoint = state[userMessageId] || {
    userMessageId,
    createdAt: new Date().toISOString(),
    files: {},
  }
  state[userMessageId] = checkpoint
  let totalBytes = Object.values(checkpoint.files).reduce((sum, snapshot) => sum + (
    snapshot.contentBase64
      ? Buffer.byteLength(snapshot.contentBase64, 'base64')
      : Buffer.byteLength(snapshot.content ?? '', 'utf8')
  ), 0)
  for (const path of paths) {
    if (checkpoint.files[path]) continue
    let fileSize = 0
    try {
      fileSize = (await stat(path)).size
    } catch {
      continue
    }
    if (fileSize > maxFileSizeBytes || totalBytes + fileSize > maxTotalBytes) {
      checkpoint.files[path] = { path, existed: true, unsupported: true }
      continue
    }
    const before = Object.keys(checkpoint.files).length
    await captureFileSnapshots(state, userMessageId, [path])
    const snapshot = state[userMessageId]?.files[path]
    if (snapshot && Object.keys(checkpoint.files).length > before) {
      totalBytes += fileSize
    }
  }
  state[userMessageId] = checkpoint
  return checkpoint
}

async function collectWorkspaceFiles(directory: string, output: string[], maxFiles: number): Promise<void> {
  if (output.length >= maxFiles) return
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (output.length >= maxFiles) return
    if (entry.isSymbolicLink()) continue
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) {
      if (!WORKSPACE_CHECKPOINT_EXCLUDED_DIRECTORIES.has(entry.name)) await collectWorkspaceFiles(path, output, maxFiles)
    } else if (entry.isFile()) {
      output.push(path)
    }
  }
}

export async function captureFileSnapshots(
  state: FileCheckpointState,
  userMessageId: string,
  paths: string[],
): Promise<FileCheckpoint | null> {
  if (!userMessageId || paths.length === 0) return null

  const checkpoint = state[userMessageId] || {
    userMessageId,
    createdAt: new Date().toISOString(),
    files: {},
  }

  for (const rawPath of paths) {
    const path = normalize(resolve(rawPath))
    if (!path || checkpoint.files[path]) continue
    try {
      const fileStat = await stat(path)
      if (fileStat.isDirectory()) continue
      const raw = await readFile(path)
      let decoded
      try {
        decoded = decodeTextFile(raw)
      } catch {
        checkpoint.files[path] = {
          path,
          existed: true,
          contentBase64: raw.toString('base64'),
        }
        continue
      }
      checkpoint.files[path] = {
        path,
        existed: true,
        content: decoded.content,
        encoding: decoded.encoding,
        lineEnding: decoded.lineEnding,
        bom: decoded.bom,
        mtimeMs: fileStat.mtimeMs,
      }
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? (error as { code?: string }).code : undefined
      checkpoint.files[path] = {
        path,
        existed: code === 'ENOENT' || code === 'ENOTDIR' ? false : true,
        ...(code === 'ENOENT' || code === 'ENOTDIR' ? {} : { unsupported: true }),
      }
    }
  }

  state[userMessageId] = checkpoint
  return checkpoint
}

export function collectCheckpointPaths(
  toolName: string,
  input: unknown,
): string[] {
  if (!input || typeof input !== 'object') return []
  const payload = input as Record<string, unknown>
  const filePath = typeof payload.file_path === 'string'
    ? payload.file_path
    : typeof payload.notebook_path === 'string'
      ? payload.notebook_path
      : null

  switch (toolName) {
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return filePath ? [filePath] : []
    case 'Bash':
      return collectShellMutationPaths(typeof payload.command === 'string' ? payload.command : '')
    default:
      return []
  }
}

export function requiresWorkspaceCheckpoint(toolName: string): boolean {
  return ['bash', 'task', 'agent', 'delegate'].includes(toolName.trim().toLowerCase())
}

function collectShellMutationPaths(command: string): string[] {
  const paths = new Set<string>()
  const patterns = [
    /(?:>>?|2>>?)\s*["']?([^\s"'|;&]+)["']?/g,
    /(?:-Path|-FilePath)\s+["']?([^\s"']+)["']?/gi,
    /(?:^|[;&|]\s*)(?:touch|rm|del|copy|cp|mv|move|mkdir|rmdir|remove-item|set-content|out-file)\s+(?:-[^\s]+\s+)*["']?([^\s"']+)["']?/gim,
  ]
  for (const pattern of patterns) {
    for (const match of command.matchAll(pattern)) {
      const candidate = match[1]?.trim()
      if (candidate && !candidate.startsWith('-')) paths.add(candidate)
    }
  }
  return [...paths]
}

export async function rewindCheckpoint(
  checkpoint: FileCheckpoint | undefined,
  dryRun = false,
): Promise<{
  canRewind: boolean
  error?: string
  filesChanged?: string[]
  skippedFiles?: string[]
  insertions?: number
  deletions?: number
}> {
  if (!checkpoint) {
    return {
      canRewind: false,
      error: 'No file checkpoint found for this message.',
    }
  }

  const filesChanged: string[] = []
  const skippedFiles: string[] = []
  let insertions = 0
  let deletions = 0

  for (const snapshot of Object.values(checkpoint.files)) {
    filesChanged.push(snapshot.path)
    if (snapshot.unsupported) {
      skippedFiles.push(snapshot.path)
      continue
    }
    if (snapshot.existed) {
      const current = await readFile(snapshot.path, 'utf-8').catch(() => '')
      const next = snapshot.contentBase64
        ? Buffer.from(snapshot.contentBase64, 'base64')
        : Buffer.from(snapshot.content || '', 'utf8')
      insertions += Math.max(0, next.length - current.length)
      deletions += Math.max(0, current.length - next.length)
      if (!dryRun) {
        const encoded = snapshot.encoding
          ? encodeTextFile(snapshot.content || '', {
              content: snapshot.content || '',
              encoding: snapshot.encoding,
              lineEnding: snapshot.lineEnding || 'LF',
              bom: snapshot.bom === true,
            })
          : next
        await mkdir(dirname(snapshot.path), { recursive: true })
        await writeFileAtomic(snapshot.path, encoded)
      }
    } else {
      const current = await readFile(snapshot.path, 'utf-8').catch(() => '')
      deletions += current.length
      if (!dryRun) {
        await rm(snapshot.path, { force: true })
      }
    }
  }

  return {
    canRewind: true,
    filesChanged,
    skippedFiles,
    insertions,
    deletions,
  }
}
