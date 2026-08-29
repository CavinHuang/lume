import { useCallback, useEffect, useRef, useState } from 'react'
import { useAtom } from 'jotai'
import { XMarkdown } from '@ant-design/x-markdown'
import { DIFF_AWARE_MARKDOWN_COMPONENTS } from '@/components/markdown/DiffAwareMarkdownPre'
import { PierreDiffView } from '@/components/diff/PierreDiffView'
import { Check, Code, Copy, Eye, ExternalLink, FolderSearch, GitCommitHorizontal, MoreHorizontal, PanelLeftClose, PanelLeftOpen, RotateCw, Save, TriangleAlert, WrapText } from 'lucide-react'
import type { FileEntry, FileRef, FileRefChangedEvent, FileRefReadResult, GuardedFileRef, WriteFileRefResult } from '@lume/shared'
import { AGENT_IPC_CHANNELS } from '@lume/shared'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { FileTypeIcon } from '@/components/file-browser/FileTypeIcon'
import {
  createFilePreviewScope,
  createGuardedFilePreviewScope,
  isDesktopRuntime,
  openGuardedFileRefInSystem,
  openFileRefInSystem,
  renderGuardedOfficePreview,
  renderOfficePreview,
  revealGuardedFileRefInSystem,
  revealFileRefInSystem,
  revokeFilePreviewScope,
  sidecarCall,
  onSidecarEvent,
  writeClipboardText,
} from '@/lib/desktop-api'
import { DocumentViewerHost } from './document-viewer/DocumentViewerHost'
import { isDocumentViewerKind } from './document-viewer/document-viewer-kinds'
import { classifyFilePreview, isMissingFileError } from './file-preview-utils'
import { cn } from '@/lib/utils'
import { RightPanelHtmlPreview } from './RightPanelHtmlPreview'
import { RightPanelOfficePreview } from './RightPanelOfficePreview'
import { RightPanelSourcePreview } from './RightPanelSourcePreview'
import { RightPanelPdbPreview } from './RightPanelPdbPreview'
import { deleteFileEditorDraft, readFileEditorDraft, writeFileEditorDraft } from './file-editor-draft-store'
import type { ThreadFileLineSelection } from '@/components/agent/thread-file-links'
import type { RightPanelFileTarget } from './right-panel-files-state'
import { FileLinkContextMenu } from '@/components/ui/FileLinkContextMenu'
import { rightPanelBlameEnabledAtom, rightPanelFileEditorStatesAtom } from '@/atoms'

type TextPayload = Extract<FileRefReadResult, { kind: 'text' }>
type ConflictState = { disk: TextPayload; local: string }

// 对齐 Proma：同一文件的高保真预览渲染一次后按 tab 复用，避免每次打开都重跑
// OfficeCLI。scope TTL 5 分钟，命中须留 60s 余量；手动刷新（refreshKey 进 key）
// 绕过缓存强制重渲。office 作用域因此不在卸载时 revoke，交给 TTL 过期与
// 主进程 1 小时临时文件清理兜底。
const OFFICE_PREVIEW_CACHE_LIMIT = 20
const officePreviewCache = new Map<string, { token: string; url: string; expiresAt: number }>()

function getFreshOfficePreview(key: string) {
  const cached = officePreviewCache.get(key)
  if (cached && cached.expiresAt - Date.now() > 60_000) return cached
  officePreviewCache.delete(key)
  return null
}

function cacheOfficePreview(key: string, entry: { token: string; url: string; expiresAt: number }) {
  officePreviewCache.delete(key)
  officePreviewCache.set(key, entry)
  while (officePreviewCache.size > OFFICE_PREVIEW_CACHE_LIMIT) {
    const oldest = officePreviewCache.keys().next().value
    if (oldest === undefined) break
    officePreviewCache.delete(oldest)
  }
}

export function RightPanelFilePreview({
  threadId,
  fileRef,
  guardedRef,
  lineSelection,
  navigationRevision,
  onOpenFile,
  onMissing,
  onPreviewScopeChange,
  onEditStart,
  treeCollapsed = false,
  onToggleTree,
  hideTitle = false,
}: {
  threadId: string
  fileRef: FileRef | null
  guardedRef?: GuardedFileRef
  lineSelection?: ThreadFileLineSelection
  navigationRevision?: number
  onOpenFile: (target: RightPanelFileTarget | FileRef) => void
  onMissing?: (ref: FileRef) => void
  onPreviewScopeChange?: (token: string | null) => void
  onEditStart?: () => void
  treeCollapsed?: boolean
  onToggleTree?: () => void
  hideTitle?: boolean
}) {
  const requestId = useRef(0)
  const [payload, setPayload] = useState<FileRefReadResult | null>(null)
  const [mediaScope, setMediaScope] = useState<{ token: string; url: string } | null>(null)
  const [officeScope, setOfficeScope] = useState<{ token: string; url: string } | null>(null)
  const [officePending, setOfficePending] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sourceMode, setSourceMode] = useState(false)
  const [wrapLines, setWrapLines] = useState(() => {
    try { return window.localStorage.getItem('lume-source-wrap') === '1' } catch { return false }
  })
  const toggleWrap = () => setWrapLines((current) => {
    const next = !current
    try { window.localStorage.setItem('lume-source-wrap', next ? '1' : '0') } catch { /* 忽略持久化失败 */ }
    return next
  })
  const [imageOriginalSize, setImageOriginalSize] = useState(false)
  const [metadata, setMetadata] = useState<FileEntry | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [editorContent, setEditorContent] = useState('')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [conflict, setConflict] = useState<ConflictState | null>(null)
  const payloadRef = useRef<FileRefReadResult | null>(null)
  const contentRef = useRef('')
  const dirtyRef = useRef(false)
  const saveTimerRef = useRef<number | null>(null)
  const dirtyTimerRef = useRef<number | null>(null)
  const editStartedRef = useRef('')
  const onMissingRef = useRef(onMissing)
  const onPreviewScopeChangeRef = useRef(onPreviewScopeChange)
  const [blameEnabled, setBlameEnabled] = useAtom(rightPanelBlameEnabledAtom)
  const [editorStates, setEditorStates] = useAtom(rightPanelFileEditorStatesAtom)
  const editorStatesRef = useRef(editorStates)
  const kind = classifyFilePreview(fileRef?.relativePath ?? '')
  const editorStateKey = fileRef ? `${threadId}:${fileRef.source}:${fileRef.scopeId}:${fileRef.relativePath}` : ''
  editorStatesRef.current = editorStates
  onMissingRef.current = onMissing
  onPreviewScopeChangeRef.current = onPreviewScopeChange

  const refresh = () => setRefreshKey((value) => value + 1)

  useEffect(() => {
    const current = ++requestId.current
    setLoading(false)
    payloadRef.current = null
    contentRef.current = ''
    editStartedRef.current = ''
    setPayload(null)
    setMediaScope(null)
    setOfficeScope(null)
    setOfficePending(false)
    setError(null)
    setSourceMode(editorStateKey
      ? editorStatesRef.current[editorStateKey]?.sourceMode ?? Boolean(lineSelection && kind === 'markdown')
      : Boolean(lineSelection && kind === 'markdown'))
    setImageOriginalSize(false)
    setMetadata(null)
    setDirty(false)
    dirtyRef.current = false
    setConflict(null)
    setSaveError(null)
    if (!fileRef) return
    let missingReported = false
    const reportMissing = (nextError: unknown) => {
      if (missingReported || !isMissingFileError(nextError)) return false
      missingReported = true
      onMissingRef.current?.(fileRef)
      return true
    }
    const statChannel = guardedRef ? AGENT_IPC_CHANNELS.STAT_GUARDED_FILE_REF : AGENT_IPC_CHANNELS.STAT_FILE_REF
    const statInput = guardedRef ? { guardedRef } : { ref: fileRef }
    void sidecarCall<FileEntry>(statChannel, statInput)
      .then((result) => { if (current === requestId.current) setMetadata(result) })
      .catch((nextError) => {
        if (current !== requestId.current) return
        if (reportMissing(nextError)) setError(errorMessage(nextError))
      })
    if (kind === 'image' || kind === 'pdf' || kind === 'video'
      || kind === 'docx' || kind === 'xlsx' || kind === 'pptx' || kind === 'csv') {
      if (!isDesktopRuntime()) {
        setError('浏览器环境不支持本地文件预览')
        return
      }
      setLoading(true)
      let token: string | null = null
      let disposed = false
      const previewScopeChange = onPreviewScopeChangeRef.current
      const createScope = guardedRef
        ? createGuardedFilePreviewScope({ guardedRef, kind: 'media-file', generation: current })
        : createFilePreviewScope({ ref: fileRef, kind: 'media-file', generation: current })
      void createScope
        .then((scope) => {
          token = scope.token
          if (disposed || current !== requestId.current) {
            void revokeFilePreviewScope(scope.token)
            return
          }
          setMediaScope(scope)
          previewScopeChange?.(scope.token)
        })
        .catch((nextError) => {
          if (!disposed && current === requestId.current) {
            setError(errorMessage(nextError))
            reportMissing(nextError)
          }
        })
        .finally(() => { if (!disposed && current === requestId.current) setLoading(false) })
      // Office 高保真渲染与 media scope 并行：对齐 Proma，渲染就绪前不挂载降级
      // 查看器（避免先显示 Extend 视图再闪切成 iframe），确认失败后再回退；
      // 命中 tab 缓存则直接复用，不重跑 OfficeCLI。
      if (kind === 'docx' || kind === 'xlsx' || kind === 'pptx') {
        const officeKey = `office:${guardedRef
          ? `${guardedRef.ref.source}:${guardedRef.ref.scopeId}:${guardedRef.ref.relativePath}`
          : `${fileRef.source}:${fileRef.scopeId}:${fileRef.relativePath}`}:${refreshKey}`
        const cachedScope = getFreshOfficePreview(officeKey)
        if (cachedScope) {
          setOfficeScope(cachedScope)
        } else {
          setOfficePending(true)
          const officeRender = guardedRef
            ? renderGuardedOfficePreview({ guardedRef, generation: current })
            : renderOfficePreview({ ref: fileRef, generation: current })
          void officeRender
            .then((scope) => {
              if (!scope) return
              // 过期响应也写入缓存：渲染结果与文件绑定，下次打开同文件可复用
              cacheOfficePreview(officeKey, scope)
              if (disposed || current !== requestId.current) return
              setOfficeScope(scope)
            })
            .catch(() => { /* 渲染失败静默回退内置查看器 */ })
            .finally(() => { if (!disposed && current === requestId.current) setOfficePending(false) })
        }
      }
      return () => {
        disposed = true
        if (token) {
          void revokeFilePreviewScope(token)
          previewScopeChange?.(null)
        }
      }
    }
    setLoading(true)
    let disposed = false
    const readChannel = guardedRef ? AGENT_IPC_CHANNELS.READ_GUARDED_FILE_REF : AGENT_IPC_CHANNELS.READ_FILE_REF
    const readInput = guardedRef ? { guardedRef } : { ref: fileRef }
    void sidecarCall<FileRefReadResult>(readChannel, readInput)
      .then((result) => {
        if (disposed || current !== requestId.current) return
        payloadRef.current = result
        setPayload(result)
        if (result.kind === 'text') {
          contentRef.current = result.content
          setEditorContent(result.content)
          if (editorStateKey && result.editable) {
            void readFileEditorDraft(editorStateKey).then((restored) => {
              if (!restored || disposed || current !== requestId.current || restored.content === restored.savedContent) return
              contentRef.current = restored.content
              setEditorContent(restored.content)
              dirtyRef.current = true
              setDirty(true)
              if (restored.mtimeMs !== result.mtimeMs) setConflict({ disk: result, local: restored.content })
            }).catch(() => undefined)
          }
        }
      })
      .catch((nextError) => {
        if (disposed || current !== requestId.current) return
        const message = errorMessage(nextError)
        setError(message)
        reportMissing(nextError)
      })
      .finally(() => { if (!disposed && current === requestId.current) setLoading(false) })
    return () => { disposed = true }
  }, [editorStateKey, guardedRef, kind, lineSelection?.end, lineSelection?.start, refreshKey])

  const saveContent = useCallback(async (content: string, expectedMtimeMs?: number) => {
    if (!fileRef || guardedRef || expectedMtimeMs === undefined) return false
    setSaving(true)
    try {
      const result = await sidecarCall<WriteFileRefResult>(AGENT_IPC_CHANNELS.WRITE_FILE_REF, {
        ref: fileRef,
        content,
        expectedMtimeMs,
      })
      if (result.outcome === 'conflict') {
        const disk = await sidecarCall<FileRefReadResult>(AGENT_IPC_CHANNELS.READ_FILE_REF, { ref: fileRef })
        if (disk.kind === 'text') setConflict({ disk, local: content })
        return false
      }
      const current = payloadRef.current
      if (current?.kind === 'text') {
        const saved: TextPayload = { ...current, content, size: result.size, mtimeMs: result.mtimeMs }
        payloadRef.current = saved
        setPayload(saved)
      }
      const stillDirty = contentRef.current !== content
      dirtyRef.current = stillDirty
      setDirty(stillDirty)
      setConflict(null)
      setSaveError(null)
      if (editorStateKey) {
        if (stillDirty) {
          void writeFileEditorDraft(editorStateKey, {
            content: contentRef.current,
            savedContent: content,
            mtimeMs: result.mtimeMs,
            updatedAt: Date.now(),
          })
        } else {
          void deleteFileEditorDraft(editorStateKey)
        }
        setEditorStates((current) => {
          const existing = current[editorStateKey]
          if (!existing && !stillDirty) return current
          return {
            ...current,
            [editorStateKey]: {
              ...(existing?.sourceMode === undefined ? {} : { sourceMode: existing.sourceMode }),
              updatedAt: Date.now(),
            },
          }
        })
      }
      if (stillDirty) {
        if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
        saveTimerRef.current = window.setTimeout(() => {
          void saveContent(contentRef.current, result.mtimeMs)
        }, 3_000)
      }
      return true
    } catch (nextError) {
      setSaveError(errorMessage(nextError))
      dirtyRef.current = true
      setDirty(true)
      return false
    } finally {
      setSaving(false)
    }
  }, [editorStateKey, fileRef, guardedRef, setEditorStates])
  const handleEditorChange = useCallback((content: string) => {
    if (onEditStart && editStartedRef.current !== editorStateKey) {
      editStartedRef.current = editorStateKey
      onEditStart()
    }
    contentRef.current = content
    setEditorContent(content)
    if (dirtyTimerRef.current !== null) window.clearTimeout(dirtyTimerRef.current)
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
    dirtyTimerRef.current = window.setTimeout(() => {
      const changed = payloadRef.current?.kind === 'text' && contentRef.current !== payloadRef.current.content
      dirtyRef.current = Boolean(changed)
      setDirty(Boolean(changed))
      const current = payloadRef.current
      if (changed && editorStateKey && current?.kind === 'text') {
        void writeFileEditorDraft(editorStateKey, {
          content: contentRef.current,
          savedContent: current.content,
          mtimeMs: current.mtimeMs,
          updatedAt: Date.now(),
        })
      } else if (!changed && editorStateKey) {
        void deleteFileEditorDraft(editorStateKey)
      }
    }, 550)
    saveTimerRef.current = window.setTimeout(() => {
      const current = payloadRef.current
      if (current?.kind === 'text' && contentRef.current !== current.content) {
        if (editorStateKey) {
          void writeFileEditorDraft(editorStateKey, {
            content: contentRef.current,
            savedContent: current.content,
            mtimeMs: current.mtimeMs,
            updatedAt: Date.now(),
          })
        }
        void saveContent(contentRef.current, current.mtimeMs)
      }
    }, 3_000)
  }, [editorStateKey, onEditStart, saveContent])

  useEffect(() => {
    if (!fileRef || guardedRef || payload?.kind !== 'text' || !payload.editable) return
    let disposed = false
    let watchId: string | null = null
    let unlistenPromise: Promise<() => void> | null = null
    void sidecarCall<{ watchId: string }>(AGENT_IPC_CHANNELS.WATCH_FILE_REF, { ref: fileRef })
      .then((result) => {
        if (disposed) {
          void sidecarCall(AGENT_IPC_CHANNELS.UNWATCH_FILE_REF, { watchId: result.watchId })
          return
        }
        watchId = result.watchId
        unlistenPromise = onSidecarEvent((method, params) => {
          if (method !== AGENT_IPC_CHANNELS.FILE_REF_CHANGED) return
          const event = params as FileRefChangedEvent
          if (event.watchId !== watchId) return
          if (event.change === 'deleted') {
            onMissing?.(fileRef)
            return
          }
          void sidecarCall<FileRefReadResult>(AGENT_IPC_CHANNELS.READ_FILE_REF, { ref: fileRef }).then((disk) => {
            if (disk.kind !== 'text') return
            const saved = payloadRef.current
            if (dirtyRef.current || (saved?.kind === 'text' && contentRef.current !== saved.content)) {
              setConflict({ disk, local: contentRef.current })
              return
            }
            payloadRef.current = disk
            contentRef.current = disk.content
            setPayload(disk)
            setEditorContent(disk.content)
          }).catch(() => undefined)
        })
      })
      .catch(() => undefined)
    return () => {
      disposed = true
      if (watchId) void sidecarCall(AGENT_IPC_CHANNELS.UNWATCH_FILE_REF, { watchId })
      if (unlistenPromise) void unlistenPromise.then((dispose) => dispose())
    }
  }, [fileRef, guardedRef, onMissing, payload?.editable, payload?.kind])

  useEffect(() => {
    const flush = () => {
      const current = payloadRef.current
      if (current?.kind === 'text' && contentRef.current !== current.content) {
        void saveContent(contentRef.current, current.mtimeMs)
      }
    }
    window.addEventListener('pagehide', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      if (dirtyTimerRef.current !== null) window.clearTimeout(dirtyTimerRef.current)
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
      flush()
    }
  }, [editorStateKey, saveContent])

  if (!fileRef) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {onToggleTree && (
          <div className="flex h-10 shrink-0 items-center border-b border-border/60 px-2.5">
            <Button variant="ghost" size="icon-sm" onClick={onToggleTree} title={treeCollapsed ? '展开文件树' : '收起文件树'}>
              {treeCollapsed ? <PanelLeftOpen size={14} /> : <PanelLeftClose size={14} />}
            </Button>
          </div>
        )}
        <div className="flex min-h-0 flex-1 items-center justify-center text-[13px] text-foreground/45">选择文件以预览</div>
      </div>
    )
  }
  const desktop = isDesktopRuntime()
  const title = (
    <span className="min-w-0 flex-1 truncate text-[12px] font-medium" title={fileRef.relativePath}>
      {basename(fileRef.relativePath)}
      <span className="ml-2 font-normal text-foreground/42">{parentPath(fileRef.relativePath)}</span>
    </span>
  )
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 overflow-x-auto overflow-y-hidden border-b border-border/60 px-2.5">
        {onToggleTree && (
          <Button variant="ghost" size="icon-sm" onClick={onToggleTree} title={treeCollapsed ? '展开文件树' : '收起文件树'}>
            {treeCollapsed ? <PanelLeftOpen size={14} /> : <PanelLeftClose size={14} />}
          </Button>
        )}
        {!hideTitle && <FileTypeIcon filename={fileRef.relativePath} size={15} />}
        {!hideTitle && (guardedRef ? (
          <FileLinkContextMenu context={{ source: 'thread', relPath: fileRef.relativePath, guardedRef }} inline>{title}</FileLinkContextMenu>
        ) : title)}
        {hideTitle && <span className="min-w-0 flex-1" />}
        {!hideTitle && <span className="min-w-0 flex-1" />}
        {(kind === 'markdown' || kind === 'html' || kind === 'pdb') && (
          <Button variant="ghost" size="icon-sm" onClick={() => setSourceMode((value) => {
            const next = !value
            if (editorStateKey) {
              setEditorStates((current) => ({
                ...current,
                [editorStateKey]: { ...current[editorStateKey], sourceMode: next, updatedAt: Date.now() },
              }))
            }
            return next
          })} title={sourceMode ? '切换到渲染视图' : '切换到源码视图'}>
            {sourceMode ? <Eye size={14} /> : <Code size={14} />}
          </Button>
        )}
        {payload?.kind === 'text' && payload.editable && (
          <span className="flex shrink-0 items-center gap-1 text-[11px] text-foreground/45">
            {saving ? <><Save size={12} />保存中</> : dirty ? <><TriangleAlert size={12} />未保存</> : <><Check size={12} />已保存</>}
          </span>
        )}
        {payload?.kind === 'text' && payload.editable && dirty && !saving && (
          <Button size="xs" onClick={() => void saveContent(contentRef.current, payload.mtimeMs)}>保存</Button>
        )}
        {saveError && <span className="max-w-40 shrink-0 truncate text-[11px] text-destructive" title={saveError}>{saveError}</span>}
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" title="更多预览操作" />}><MoreHorizontal size={14} /></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {kind === 'image' && <DropdownMenuItem onSelect={() => setImageOriginalSize((value) => !value)}>{imageOriginalSize ? '切换到适应尺寸' : '切换到原始尺寸'}</DropdownMenuItem>}
            {fileRef.source === 'project' && (kind === 'text' || kind === 'unsupported' || sourceMode) && (
              <DropdownMenuItem onSelect={() => setBlameEnabled((value) => !value)}>
                <GitCommitHorizontal size={13} />
                {blameEnabled ? '关闭 Git Blame' : '显示 Git Blame'}
              </DropdownMenuItem>
            )}
            {payload?.kind === 'text' && <DropdownMenuItem onSelect={() => void writeClipboardText(editorContent)}>复制内容</DropdownMenuItem>}
            <DropdownMenuItem onSelect={toggleWrap}>
              <WrapText size={13} />
              {wrapLines ? '关闭自动换行' : '开启自动换行'}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={refresh}><RotateCw size={13} />刷新预览</DropdownMenuItem>
            <DropdownMenuItem disabled={!desktop} onSelect={() => void (guardedRef ? openGuardedFileRefInSystem(guardedRef) : openFileRefInSystem(fileRef))}><ExternalLink size={13} />系统打开</DropdownMenuItem>
            <DropdownMenuItem disabled={!desktop} onSelect={() => void (guardedRef ? revealGuardedFileRefInSystem(guardedRef) : revealFileRefInSystem(fileRef))}><FolderSearch size={13} />在文件管理器中显示</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void writeClipboardText(fileRef.relativePath)}><Copy size={13} />复制相对路径</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {loading ? (
          <PreviewStatus>正在读取文件…</PreviewStatus>
        ) : error ? (
          <PreviewStatus>{error}</PreviewStatus>
        ) : (kind === 'unsupported' && payload?.kind !== 'text') || payload?.kind === 'binary' || payload?.kind === 'too-large' ? (
          <PreviewStatus>
            {payload?.kind === 'too-large' ? '文件超过 20 MB，未加载正文。' : '此文件类型不支持内嵌预览，可使用系统应用打开。'}
            {metadata && <span className="mt-2 block text-[11px]">{metadata.size === undefined ? '大小未知' : formatBytes(metadata.size)} · {metadata.modifiedAt ? new Date(metadata.modifiedAt).toLocaleString() : '修改时间未知'}</span>}
          </PreviewStatus>
        ) : kind === 'image' ? (
          mediaScope ? (
            <FileLinkContextMenu
              context={{ source: 'thread', relPath: fileRef.relativePath, fileRef, guardedRef }}
              isImage
              directTrigger
            >
              <img src={mediaScope.url} alt={basename(fileRef.relativePath)} onError={() => setError('图片预览加载失败')} className={imageOriginalSize ? 'm-auto max-w-none' : 'm-auto max-h-full max-w-full object-contain'} />
            </FileLinkContextMenu>
          ) : null
        ) : isDocumentViewerKind(kind) && mediaScope ? (
          officeScope ? (
            <RightPanelOfficePreview url={officeScope.url} title={`${basename(fileRef.relativePath)} 高保真预览`} />
          ) : officePending ? (
            <PreviewStatus>正在加载 Office 预览…</PreviewStatus>
          ) : (
            <DocumentViewerHost
              kind={kind}
              fileRef={fileRef}
              guardedRef={guardedRef}
              mediaScope={mediaScope}
              onOpenFile={onOpenFile}
            />
          )
        ) : kind === 'video' && mediaScope ? (
          <div className="flex h-full items-center justify-center bg-black/90 p-4">
            <video src={mediaScope.url} controls className="max-h-full max-w-full" />
          </div>
        ) : conflict ? (
          <div className="flex h-full min-h-0 flex-col">
            <div className="flex shrink-0 items-center gap-2 border-b border-amber-500/25 bg-amber-500/8 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
              <TriangleAlert size={14} />
              <span className="min-w-0 flex-1">文件已在磁盘上发生变化，请选择要保留的版本。</span>
              <Button variant="ghost" size="xs" onClick={() => {
                payloadRef.current = conflict.disk
                contentRef.current = conflict.disk.content
                setPayload(conflict.disk)
                setEditorContent(conflict.disk.content)
                setConflict(null)
                setDirty(false)
                dirtyRef.current = false
                if (editorStateKey) void deleteFileEditorDraft(editorStateKey)
                if (editorStateKey) {
                  setEditorStates((current) => ({
                    ...current,
                    [editorStateKey]: {
                      ...(current[editorStateKey]?.sourceMode === undefined
                        ? {}
                        : { sourceMode: current[editorStateKey]!.sourceMode }),
                      updatedAt: Date.now(),
                    },
                  }))
                }
              }}>接受磁盘版本</Button>
              <Button size="xs" onClick={() => void saveContent(conflict.local, conflict.disk.mtimeMs)}>保留本地版本</Button>
              <Button variant="ghost" size="xs" onClick={() => {
                payloadRef.current = conflict.disk
                setPayload(conflict.disk)
                setConflict(null)
                dirtyRef.current = true
                setDirty(true)
              }}>继续编辑</Button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              <RightPanelSourceConflict filePath={fileRef.relativePath} disk={conflict.disk.content} local={conflict.local} />
            </div>
          </div>
        ) : payload?.kind === 'text' ? (
          <div className={cn('h-full overflow-auto', wrapLines && '[&_pre]:whitespace-pre-wrap [&_pre]:overflow-wrap-anywhere')}>
            {kind === 'html' && !sourceMode ? (
              <RightPanelHtmlPreview fileRef={fileRef} guardedRef={guardedRef} source={editorContent} onOpenFile={onOpenFile} onMissing={onMissing} onPreviewScopeChange={onPreviewScopeChange} />
            ) : kind === 'markdown' && !sourceMode ? (
              <XMarkdown components={DIFF_AWARE_MARKDOWN_COMPONENTS} className="x-markdown text-[13px] leading-6">{editorContent}</XMarkdown>
            ) : kind === 'pdb' && !sourceMode ? (
              <RightPanelPdbPreview source={editorContent} />
            ) : (
              <RightPanelSourcePreview
                threadId={threadId}
                content={editorContent}
                filePath={fileRef.relativePath}
                fileRef={fileRef}
                blameEnabled={fileRef.source === 'project' && blameEnabled}
                lineSelection={kind === 'text' || kind === 'markdown' || kind === 'unsupported' ? lineSelection : undefined}
                navigationRevision={navigationRevision}
                editable={!guardedRef && payload.editable}
                editorCacheKey={`${fileRef.source}:${fileRef.scopeId}:${fileRef.relativePath}`}
                onContentChange={handleEditorChange}
                wrapLines={wrapLines}
              />
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
}

export function PreviewStatus({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full min-h-48 items-center justify-center px-6 text-center text-[13px] text-foreground/55">{children}</div>
}

function RightPanelSourceConflict({ filePath, disk, local }: { filePath: string; disk: string; local: string }) {
  return (
    <PierreDiffView
      filePath={filePath}
      oldContent={disk}
      newContent={local}
      expandUnchanged={false}
      collapsedContextThreshold={4}
      virtualizer="parent"
      disableHeader
    />
  )
}

function basename(path: string) { return path.replace(/\\/g, '/').split('/').at(-1) ?? path }
function parentPath(path: string) { return path.replace(/\\/g, '/').split('/').slice(0, -1).join('/') }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : '读取文件失败' }
function formatBytes(size: number) {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${Math.round(size / 102.4) / 10} KB`
  return `${Math.round(size / 1024 / 102.4) / 10} MB`
}
