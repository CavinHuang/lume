export type MemoryCenterSection = 'attention' | 'memory' | 'insights' | 'activity'
export type MemoryLibraryView = 'recent' | 'about' | 'workspace' | 'all'

export interface MemoryCenterDeepLink {
  section: MemoryCenterSection
  workspaceSlug?: string
  libraryView?: MemoryLibraryView
  memoryId?: string
  mutationId?: string
  jobId?: string
}

export const DEFAULT_MEMORY_CENTER_LINK: MemoryCenterDeepLink = { section: 'attention' }

const SECTIONS: readonly MemoryCenterSection[] = ['attention', 'memory', 'insights', 'activity']
const LIBRARY_VIEWS: readonly MemoryLibraryView[] = ['recent', 'about', 'workspace', 'all']

export function normalizeMemoryCenterLink(
  input?: Partial<MemoryCenterDeepLink> | null,
  workspaceSlug?: string | null,
): MemoryCenterDeepLink {
  const section = input?.section && SECTIONS.includes(input.section) ? input.section : DEFAULT_MEMORY_CENTER_LINK.section
  const libraryView = input?.libraryView && LIBRARY_VIEWS.includes(input.libraryView) ? input.libraryView : undefined
  const matchesWorkspace = !input?.workspaceSlug || input.workspaceSlug === workspaceSlug
  return {
    section,
    ...(workspaceSlug ? { workspaceSlug } : {}),
    ...(libraryView ? { libraryView } : {}),
    ...(matchesWorkspace && input?.memoryId ? { memoryId: input.memoryId } : {}),
    ...(input?.mutationId ? { mutationId: input.mutationId } : {}),
    ...(matchesWorkspace && input?.jobId ? { jobId: input.jobId } : {}),
  }
}

export function isMemoryCenterLinkForWorkspace(link: MemoryCenterDeepLink, workspaceSlug?: string | null): boolean {
  return Boolean(workspaceSlug) && (!link.workspaceSlug || link.workspaceSlug === workspaceSlug)
}
