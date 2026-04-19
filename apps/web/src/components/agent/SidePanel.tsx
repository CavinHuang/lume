import { useState } from 'react'
import { FileBrowser } from '@/components/file-browser/FileBrowser'
import { FileDropZone } from '@/components/file-browser/FileDropZone'
import { PlanPanel } from './PlanPanel'
import type { SidePanelView } from '@/atoms'

interface SidePanelProps {
  threadId: string
  view: SidePanelView
  workspaceSlug?: string
}

export function SidePanel({ threadId, view, workspaceSlug }: SidePanelProps) {
  const [refreshToken, setRefreshToken] = useState(0)

  return (
    <div className="w-72 flex-shrink-0 border-l border-border/50 flex flex-col overflow-hidden">
      {view === 'files' && (
        <>
          <div className="flex-1 min-h-0">
            <FileBrowser threadId={threadId} workspaceSlug={workspaceSlug} refreshToken={refreshToken} />
          </div>
          <FileDropZone
            threadId={threadId}
            workspaceSlug={workspaceSlug}
            onFilesUploaded={() => setRefreshToken((t) => t + 1)}
          />
        </>
      )}
      {view === 'plan' && <PlanPanel threadId={threadId} />}
    </div>
  )
}
