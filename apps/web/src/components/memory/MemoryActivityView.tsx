import * as React from 'react'
import { useAtomValue } from 'jotai'
import { agentWorkspacesAtom, currentWorkspaceIdAtom, memoryCenterDeepLinkAtom } from '@/atoms'
import { MemoryActivityPanel } from '@/components/settings/MemoryActivityPanel'
import { MemoryJobActivityPanel } from '@/components/settings/MemoryJobActivityPanel'
import { MemoryOperationsPanel } from './MemoryLibraryView'
import { useMemoryCenter } from './use-memory-center'

export function MemoryActivityView() {
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const currentWorkspaceId = useAtomValue(currentWorkspaceIdAtom)
  const deepLink = useAtomValue(memoryCenterDeepLinkAtom)
  const workspace = React.useMemo(
    () => workspaces.find((item) => item.id === currentWorkspaceId) ?? workspaces[0] ?? null,
    [currentWorkspaceId, workspaces],
  )
  const workspaceSlug = workspace?.slug ?? null
  const controller = useMemoryCenter(workspaceSlug, deepLink)
  const { snapshot, busyAction, actions } = controller

  if (!workspaceSlug) {
    return (
      <section className="lume-panel p-4">
        <h2 className="text-[14px] font-semibold text-[var(--text-1)]">暂无工作区</h2>
        <p className="mt-1 text-[12px] text-[var(--text-3)]">创建或选择一个工作区后即可查看记忆活动。</p>
      </section>
    )
  }

  return (
    <div className="space-y-4">
      <section className="lume-panel p-4">
        <div className="text-[14px] font-semibold text-[var(--text-1)]">记忆变更</div>
        <div className="mt-3">
          <MemoryActivityPanel
            items={snapshot?.activity ?? []}
            selectedMutationId={deepLink.mutationId}
            busyAction={busyAction}
            onOpenMemory={actions.openActivityMemory}
            onUndo={(mutationId) => void actions.undoActivityMutation(mutationId)}
          />
        </div>
      </section>
      <section className="lume-panel p-4">
        <div className="text-[14px] font-semibold text-[var(--text-1)]">后台任务</div>
        <div className="mt-3 space-y-2">
          <MemoryJobActivityPanel
            items={snapshot?.jobs ?? []}
            busyAction={busyAction}
            onRetry={(jobId) => void actions.retryJob(jobId)}
            onCancel={(jobId) => void actions.cancelJob(jobId)}
            onOpenMemory={actions.openActivityMemory}
            onUndo={(mutationId) => void actions.undoActivityMutation(mutationId)}
          />
        </div>
      </section>
      <MemoryOperationsPanel
        busyAction={busyAction}
        snapshot={snapshot}
        onCancelJob={(jobId) => void actions.cancelJob(jobId)}
        onOrganizeEntries={() => void actions.organizeEntries()}
        onOrganizeHistory={() => void actions.organizeHistory()}
        onIngestPastedText={() => void actions.ingestPastedText()}
        onIngestLocalFiles={() => void actions.ingestLocalFiles()}
        onIngestLocalFolder={() => void actions.ingestLocalFolder()}
        onIngestWorkspaceFile={() => void actions.ingestWorkspaceFile()}
        onOpenFile={(path) => void actions.openMemoryFile(path)}
        externalText={controller.externalText}
        ingestJob={controller.ingestJob}
        ingestResult={controller.ingestResult}
        ingestTargetScope={controller.ingestTargetScope}
        entryOrganizeJob={controller.entryOrganizeJob}
        entryOrganizeResult={controller.entryOrganizeResult}
        historyOrganizeJob={controller.historyOrganizeJob}
        organizeResult={controller.organizeResult}
        workspaceFilePath={controller.workspaceFilePath}
        onExternalTextChange={actions.setExternalText}
        onIngestTargetScope={actions.setIngestTargetScope}
        onWorkspaceFilePathChange={actions.setWorkspaceFilePath}
      />
    </div>
  )
}
