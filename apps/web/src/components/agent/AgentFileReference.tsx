import { useMemo, useState } from 'react'
import type { FileRef, FileReferenceBinding, GuardedFileRef } from '@lume/shared'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { FileTypeIcon } from '@/components/file-browser/FileTypeIcon'
import { FileLinkContextMenu } from '@/components/ui/FileLinkContextMenu'
import { cn } from '@/lib/utils'
import { useMessageFileReferenceConsumerThreadId, useThreadFileEnv } from './thread-file-env'
import type { ParsedThreadFileReference, ThreadFileLineSelection } from './thread-file-links'

export type ThreadFileNavigationStatus =
  | 'opened'
  | 'superseded'
  | 'not_found'
  | 'out_of_scope'
  | 'binding_changed'
  | 'kind_mismatch'
  | 'unavailable'
  | 'io_error'

export interface ThreadFileOpenOptions {
  guardedRef?: GuardedFileRef
  fileReferenceBinding?: FileReferenceBinding
  isDirectory?: boolean
  lineSelection?: ThreadFileLineSelection
}

export type OpenThreadFile = (
  path: string,
  fileRef?: FileRef,
  options?: ThreadFileOpenOptions,
) => Promise<ThreadFileNavigationStatus> | ThreadFileNavigationStatus | void

export function AgentFileReference({
  reference,
  binding,
  onOpen,
}: {
  reference: ParsedThreadFileReference
  binding?: FileReferenceBinding
  onOpen: OpenThreadFile
}) {
  const env = useThreadFileEnv()
  const messageConsumerThreadId = useMessageFileReferenceConsumerThreadId()
  const [invalidReason, setInvalidReason] = useState<string | null>(null)
  const consumerThreadId = messageConsumerThreadId ?? env.threadId
  const guardedRef = useMemo(() => buildGuardedFileRef(reference, binding, consumerThreadId), [binding, consumerThreadId, reference])
  const inheritedSessionUnavailable = reference.source === 'session'
    && Boolean(binding?.fileContextId && env.fileContextId && binding.fileContextId !== env.fileContextId)
  const unavailableReason = reference.source !== 'legacy-session' && !guardedRef
    ? '此消息缺少可验证的文件绑定'
    : inheritedSessionUnavailable
      ? '来自原会话，当前分叉不可用'
      : null
  const deterministicInvalid = invalidReason ?? unavailableReason
  const sourceLabel = reference.source === 'project' ? '项目' : reference.source === 'session' ? '会话' : '旧版会话'
  const lineLabel = reference.lineSelection
    ? reference.lineSelection.start === reference.lineSelection.end
      ? `L${reference.lineSelection.start}`
      : `L${reference.lineSelection.start}–${reference.lineSelection.end}`
    : ''
  const fullLabel = `${sourceLabel}：${reference.relativePath}${reference.isDirectory ? '/' : ''}${lineLabel ? `#${lineLabel}` : ''}`
  const label = compactPath(reference.relativePath, reference.isDirectory)

  const open = async () => {
    if (unavailableReason) return
    const result = await onOpen(reference.relativePath, undefined, {
      guardedRef,
      fileReferenceBinding: binding,
      isDirectory: reference.isDirectory,
      lineSelection: reference.lineSelection,
    })
    if (result === 'opened') setInvalidReason(null)
    if (result === 'not_found') setInvalidReason('文件不存在')
    if (result === 'out_of_scope') setInvalidReason('文件超出授权范围')
    if (result === 'binding_changed') setInvalidReason('文件绑定已改变')
    if (result === 'kind_mismatch') setInvalidReason('文件类型与引用声明不一致')
    if (result === 'unavailable' || result === 'io_error') toast.error('暂时无法打开文件引用')
  }

  const button = (
    <Button
      variant="ghost"
      type="button"
      data-agent-file-reference="true"
      data-thread-file-link="true"
      data-file-link-highlight="true"
      data-file-reference-copy-text={reference.copyText}
      data-invalid={deterministicInvalid ? 'true' : undefined}
      aria-label={`${fullLabel}${deterministicInvalid ? `（${deterministicInvalid}）` : ''}`}
      title={`${fullLabel}${deterministicInvalid ? ` — ${deterministicInvalid}` : ''}`}
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        void open()
      }}
      className={cn(
        'inline-flex h-auto max-w-full items-center gap-1 rounded-md border px-1.5 py-0.5 align-baseline font-mono text-[0.9em] font-medium shadow-[0_1px_0_hsl(var(--lume-shadow-panel)/0.08)]',
        deterministicInvalid
          ? 'border-destructive/30 bg-destructive/5 text-destructive/70 line-through decoration-destructive/40'
          : 'border-[color:color-mix(in_oklab,var(--lume-accent)_28%,var(--lume-border-subtle))] bg-[var(--lume-accent-soft)] text-[var(--lume-accent)] hover:border-[color:color-mix(in_oklab,var(--lume-accent)_46%,var(--lume-border-strong))] hover:text-[var(--lume-text-primary)]',
      )}
    >
      <span aria-hidden="true" data-file-link-icon="true" className="inline-flex shrink-0 items-center">
        <FileTypeIcon filename={reference.relativePath} isDirectory={reference.isDirectory} size={13} />
      </span>
      <span className="truncate">{label}</span>
      {lineLabel && <span className="shrink-0 text-[0.85em] font-normal opacity-55">{lineLabel}</span>}
    </Button>
  )

  if (!guardedRef && reference.source !== 'legacy-session') return button
  return (
    <FileLinkContextMenu
      context={{
        source: 'thread',
        relPath: `${reference.relativePath}${reference.isDirectory ? '/' : ''}`,
        threadId: consumerThreadId,
        workspaceSlug: env.workspaceSlug,
        ...(guardedRef ? { guardedRef } : {}),
        ...(reference.source === 'legacy-session' ? {} : { protocolReference: reference.protocolReference }),
        isDirectory: reference.isDirectory,
      }}
      onPreview={() => void open()}
      inline
    >
      {button}
    </FileLinkContextMenu>
  )
}

function buildGuardedFileRef(
  reference: ParsedThreadFileReference,
  binding: FileReferenceBinding | undefined,
  consumerThreadId: string | undefined,
): GuardedFileRef | undefined {
  if (!binding || !consumerThreadId) return undefined
  if (reference.source === 'project') {
    if (!binding.workspaceSlug || !binding.projectRootFingerprint) return undefined
    return {
      ref: { source: 'project', scopeId: binding.workspaceSlug, relativePath: reference.relativePath },
      expectedKind: reference.isDirectory ? 'directory' : 'file',
      guard: {
        kind: 'project',
        workspaceSlug: binding.workspaceSlug,
        expectedProjectRootFingerprint: binding.projectRootFingerprint,
        consumerThreadId,
      },
    }
  }
  if (reference.source === 'session') {
    return {
      ref: { source: 'session', scopeId: binding.fileContextId, relativePath: reference.relativePath },
      expectedKind: reference.isDirectory ? 'directory' : 'file',
      guard: { kind: 'session', consumerThreadId, expectedFileContextId: binding.fileContextId },
    }
  }
  return undefined
}

function compactPath(path: string, directory: boolean): string {
  const suffix = directory ? '/' : ''
  if (path.length <= 36) return `${path}${suffix}`
  const segments = path.split('/')
  return `…/${segments.slice(-2).join('/')}${suffix}`
}
