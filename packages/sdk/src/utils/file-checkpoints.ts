import { mkdir, readFile, rm, stat, writeFile, rename } from 'fs/promises'
import { basename, dirname, join, normalize, resolve } from 'path'
import { decodeTextFile, encodeTextFile } from './text-file.js'

export interface FileSnapshot {
  path: string
  existed: boolean
  content?: string
  mtimeMs?: number
  encoding?: 'utf8' | 'utf16le'
  lineEnding?: 'CRLF' | 'LF' | 'CR'
  bom?: boolean
}

export interface FileCheckpoint {
  userMessageId: string
  createdAt: string
  files: Record<string, FileSnapshot>
}

export type FileCheckpointState = Record<string, FileCheckpoint>

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
      const decoded = decodeTextFile(await readFile(path))
      checkpoint.files[path] = {
        path,
        existed: true,
        content: decoded.content,
        encoding: decoded.encoding,
        lineEnding: decoded.lineEnding,
        bom: decoded.bom,
        mtimeMs: fileStat.mtimeMs,
      }
    } catch {
      checkpoint.files[path] = {
        path,
        existed: false,
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
    default:
      return []
  }
}

export async function rewindCheckpoint(
  checkpoint: FileCheckpoint | undefined,
  dryRun = false,
): Promise<{
  canRewind: boolean
  error?: string
  filesChanged?: string[]
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
  let insertions = 0
  let deletions = 0

  for (const snapshot of Object.values(checkpoint.files)) {
    filesChanged.push(snapshot.path)
    if (snapshot.existed) {
      const current = await readFile(snapshot.path, 'utf-8').catch(() => '')
      const next = snapshot.content || ''
      insertions += Math.max(0, next.length - current.length)
      deletions += Math.max(0, current.length - next.length)
      if (!dryRun) {
        const encoded = snapshot.encoding
          ? encodeTextFile(next, {
              content: next,
              encoding: snapshot.encoding,
              lineEnding: snapshot.lineEnding || 'LF',
              bom: snapshot.bom === true,
            })
          : Buffer.from(next, 'utf8')
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
    insertions,
    deletions,
  }
}

async function writeFileAtomic(filePath: string, content: Uint8Array): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  const tempPath = join(dirname(filePath), `.${basename(filePath)}.${crypto.randomUUID()}.tmp`)
  try {
    await writeFile(tempPath, content)
    await rename(tempPath, filePath)
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined)
    throw error
  }
}
