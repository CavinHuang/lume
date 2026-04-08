import { mkdir, readFile, rm, stat, writeFile } from 'fs/promises'
import { dirname } from 'path'

export interface FileSnapshot {
  path: string
  existed: boolean
  content?: string
  mtimeMs?: number
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

  for (const path of paths) {
    if (!path || checkpoint.files[path]) continue
    try {
      const fileStat = await stat(path)
      if (fileStat.isDirectory()) continue
      checkpoint.files[path] = {
        path,
        existed: true,
        content: await readFile(path, 'utf-8'),
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
  const filePath = typeof payload.file_path === 'string' ? payload.file_path : null

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
        await mkdir(dirname(snapshot.path), { recursive: true })
        await writeFile(snapshot.path, next, 'utf-8')
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

