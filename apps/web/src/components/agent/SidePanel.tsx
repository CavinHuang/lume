import { useState } from 'react'
import { FolderOpen, Globe } from 'lucide-react'
import { FileBrowser } from '@/components/file-browser/FileBrowser'
import { WorkspaceFileBrowser } from '@/components/file-browser/WorkspaceFileBrowser'
import { FileDropZone } from '@/components/file-browser/FileDropZone'
import { TaskProgressPanel } from './TaskProgressPanel'
import { TracePanel } from './TracePanel'
import { cn } from '@/lib/utils'
import type { SidePanelView } from '@/atoms'

type FileTab = 'thread' | 'workspace'

interface SidePanelProps {
  threadId: string
  view: SidePanelView
  workspaceSlug?: string
}

export function SidePanel({ threadId, view, workspaceSlug }: SidePanelProps) {
  const [refreshToken, setRefreshToken] = useState(0)
  const [fileTab, setFileTab] = useState<FileTab>('thread')

  return (
    <div className="w-72 flex-shrink-0 border-l border-border/50 flex flex-col overflow-hidden">
      {view === 'files' && (
        <>
          {/* Tab 栏 */}
          <div className="flex border-b border-border/50">
            <button
              onClick={() => setFileTab('thread')}
              className={cn(
                'flex-1 flex items-center justify-center gap-1.5 px-2 py-2 text-[11px] font-medium transition-colors',
                fileTab === 'thread'
                  ? 'text-foreground/80 border-b-2 border-foreground/60'
                  : 'text-foreground/40 hover:text-foreground/60'
              )}
            >
              <FolderOpen size={12} />
              线程
            </button>
            <button
              onClick={() => setFileTab('workspace')}
              className={cn(
                'flex-1 flex items-center justify-center gap-1.5 px-2 py-2 text-[11px] font-medium transition-colors',
                fileTab === 'workspace'
                  ? 'text-foreground/80 border-b-2 border-foreground/60'
                  : 'text-foreground/40 hover:text-foreground/60'
              )}
            >
              <Globe size={12} />
              工作区共享
            </button>
          </div>

          {/* Tab 内容 */}
          {fileTab === 'thread' ? (
            <div className="flex-1 min-h-0 flex flex-col">
              <div className="flex-1 min-h-0">
                <FileBrowser threadId={threadId} workspaceSlug={workspaceSlug} refreshToken={refreshToken} />
              </div>
              <FileDropZone
                threadId={threadId}
                workspaceSlug={workspaceSlug}
                onFilesUploaded={() => setRefreshToken((t) => t + 1)}
              />
            </div>
          ) : (
            <div className="flex-1 min-h-0">
              <WorkspaceFileBrowser workspaceSlug={workspaceSlug} refreshToken={refreshToken} />
            </div>
          )}
        </>
      )}
      {view === 'plan' && <TaskProgressPanel threadId={threadId} />}
      {view === 'trace' && <TracePanel threadId={threadId} />}
    </div>
  )
}
