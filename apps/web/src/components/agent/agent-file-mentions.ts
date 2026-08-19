import { sidecarCall } from '@/lib/desktop-api'
import {
  AGENT_IPC_CHANNELS,
  type FileEntry,
  type FileIndexEntry,
  type FileRef,
  type FileSearchResult,
} from '@lume/shared'
import type { MentionItem } from './slash-command-state'

export type MentionFileSource = 'project' | 'session'

function getSessionRootRef(entries: FileEntry[]): FileRef | undefined {
  const ref = entries.find((entry) => entry.ref?.source === 'session')?.ref
  return ref ? { ...ref, relativePath: '' } : undefined
}

function toFileIndexEntry(entry: FileEntry): FileIndexEntry {
  return {
    name: entry.name,
    path: entry.ref?.relativePath ?? entry.name,
    type: entry.isDirectory ? 'dir' : 'file',
    ref: entry.ref,
  }
}

export function buildFileMentionItems(
  entries: FileIndexEntry[],
  source: MentionFileSource,
  query: string,
): MentionItem[] {
  const section = source === 'project' ? 'project-file' : 'session-file'
  const sourceLabel = source === 'project' ? '项目' : '会话'
  return entries
    .filter((entry) => entry.type === 'file')
    .filter((entry) => !query || `${entry.name}\n${entry.path}`.toLowerCase().includes(query))
    .sort((left, right) => {
      const leftStarts = left.name.toLowerCase().startsWith(query) ? 0 : 1
      const rightStarts = right.name.toLowerCase().startsWith(query) ? 0 : 1
      return leftStarts - rightStarts || left.path.length - right.path.length
    })
    .slice(0, 12)
    .map((entry) => ({
      id: `${source}:${entry.path}`,
      label: `${source}/${entry.path}`,
      title: entry.name,
      subtitle: entry.path,
      type: 'file' as const,
      section,
      meta: sourceLabel,
    }))
}

/** 获取 @ 面板中的项目文件与会话文件建议；无会话（如欢迎页）时仅项目文件。 */
export async function fetchFileMentionItems(
  query: string,
  workspaceSlug: string | null,
  threadId: string,
): Promise<MentionItem[]> {
  const normalizedQuery = query.trim().toLowerCase()
  try {
    const [projectResult, sessionResult] = await Promise.all([
      workspaceSlug
        ? sidecarCall<{ entries: FileEntry[] }>(AGENT_IPC_CHANNELS.LIST_PROJECT_DIRECTORY, { workspaceSlug, path: '.' })
            .catch(() => ({ entries: [] as FileEntry[] }))
        : Promise.resolve({ entries: [] as FileEntry[] }),
      sidecarCall<{ entries: FileEntry[] }>(AGENT_IPC_CHANNELS.LIST_DIRECTORY, {
        ...(workspaceSlug ? { workspaceSlug } : {}),
        threadId,
        path: '.',
      }).catch(() => ({ entries: [] as FileEntry[] })),
    ])

    const roots: Array<{ source: MentionFileSource; entries: FileEntry[]; ref?: FileRef }> = [
      {
        source: 'project',
        entries: projectResult.entries ?? [],
        ref: workspaceSlug ? { source: 'project', scopeId: workspaceSlug, relativePath: '' } : undefined,
      },
      {
        source: 'session',
        entries: sessionResult.entries ?? [],
        ref: getSessionRootRef(sessionResult.entries ?? []),
      },
    ]

    const results = normalizedQuery
      ? await Promise.all(roots.map(async (root) => {
          if (!root.ref) return { source: root.source, entries: root.entries.map(toFileIndexEntry) }
          try {
            const result = await sidecarCall<FileSearchResult>(AGENT_IPC_CHANNELS.SEARCH_FILE_REFS, {
              ref: root.ref,
              query: normalizedQuery,
              limit: 40,
              includeExcluded: false,
            })
            return { source: root.source, entries: result.entries ?? [] }
          } catch {
            return { source: root.source, entries: root.entries.map(toFileIndexEntry) }
          }
        }))
      : roots.map((root) => ({ source: root.source, entries: root.entries.map(toFileIndexEntry) }))

    return results.flatMap(({ source, entries }) => buildFileMentionItems(entries, source, normalizedQuery))
  } catch {
    return []
  }
}
