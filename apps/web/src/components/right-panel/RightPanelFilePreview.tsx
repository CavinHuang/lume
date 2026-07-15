import { useEffect, useRef, useState } from 'react'
import { XMarkdown } from '@ant-design/x-markdown'
import { Copy, ExternalLink, FolderSearch, RotateCw } from 'lucide-react'
import type { FileEntry, FileRef } from '@lume/shared'
import { AGENT_IPC_CHANNELS } from '@lume/shared'
import { Button } from '@/components/ui/button'
import { FileTypeIcon } from '@/components/file-browser/FileTypeIcon'
import {
  createFilePreviewScope,
  isDesktopRuntime,
  openFileRefInSystem,
  revealFileRefInSystem,
  revokeFilePreviewScope,
  sidecarCall,
  writeClipboardText,
} from '@/lib/desktop-api'
import { classifyFilePreview, isMissingFileError } from './file-preview-utils'
import { RightPanelHtmlPreview } from './RightPanelHtmlPreview'

interface PreviewPayload { content: string; truncated: boolean }

export function RightPanelFilePreview({
  fileRef,
  onOpenFile,
  onMissing,
  onPreviewScopeChange,
}: {
  fileRef: FileRef | null
  onOpenFile: (ref: FileRef) => void
  onMissing?: (ref: FileRef) => void
  onPreviewScopeChange?: (token: string | null) => void
}) {
  const requestId = useRef(0)
  const [payload, setPayload] = useState<PreviewPayload | null>(null)
  const [imageScope, setImageScope] = useState<{ token: string; url: string } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sourceMode, setSourceMode] = useState(false)
  const [imageOriginalSize, setImageOriginalSize] = useState(false)
  const [metadata, setMetadata] = useState<FileEntry | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const kind = classifyFilePreview(fileRef?.relativePath ?? '')

  const refresh = () => setRefreshKey((value) => value + 1)

  useEffect(() => {
    const current = ++requestId.current
    setLoading(false)
    setPayload(null)
    setImageScope(null)
    setError(null)
    setSourceMode(false)
    setImageOriginalSize(false)
    setMetadata(null)
    if (!fileRef) return
    let missingReported = false
    const reportMissing = (nextError: unknown) => {
      if (missingReported || !isMissingFileError(nextError)) return false
      missingReported = true
      onMissing?.(fileRef)
      return true
    }
    void sidecarCall<FileEntry>(AGENT_IPC_CHANNELS.STAT_FILE_REF, { ref: fileRef })
      .then((result) => { if (current === requestId.current) setMetadata(result) })
      .catch((nextError) => {
        if (current !== requestId.current) return
        if (reportMissing(nextError)) setError(errorMessage(nextError))
      })
    if (kind === 'image') {
      if (!isDesktopRuntime()) {
        setError('浏览器环境不支持本地图片预览')
        return
      }
      setLoading(true)
      let token: string | null = null
      let disposed = false
      void createFilePreviewScope({ ref: fileRef, kind: 'media-file', generation: current })
        .then((scope) => {
          token = scope.token
          if (disposed || current !== requestId.current) {
            void revokeFilePreviewScope(scope.token)
            return
          }
          setImageScope(scope)
          onPreviewScopeChange?.(scope.token)
        })
        .catch((nextError) => {
          if (!disposed && current === requestId.current) {
            setError(errorMessage(nextError))
            reportMissing(nextError)
          }
        })
        .finally(() => { if (!disposed && current === requestId.current) setLoading(false) })
      return () => {
        disposed = true
        if (token) {
          void revokeFilePreviewScope(token)
          onPreviewScopeChange?.(null)
        }
      }
    }
    if (kind === 'unsupported') return
    setLoading(true)
    let disposed = false
    void sidecarCall<PreviewPayload>(AGENT_IPC_CHANNELS.READ_FILE_REF, { ref: fileRef })
      .then((result) => {
        if (!disposed && current === requestId.current) setPayload(result)
      })
      .catch((nextError) => {
        if (disposed || current !== requestId.current) return
        const message = errorMessage(nextError)
        setError(message)
        reportMissing(nextError)
      })
      .finally(() => { if (!disposed && current === requestId.current) setLoading(false) })
    return () => { disposed = true }
  }, [fileRef, kind, onMissing, onPreviewScopeChange, refreshKey])

  if (!fileRef) {
    return <div className="flex h-full items-center justify-center text-[13px] text-foreground/45">选择文件以预览</div>
  }
  const desktop = isDesktopRuntime()
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/60 px-2.5">
        <FileTypeIcon filename={fileRef.relativePath} size={15} />
        <div className="min-w-0 flex-1 truncate text-[12px] font-medium" title={fileRef.relativePath}>
          {basename(fileRef.relativePath)}
          <span className="ml-2 font-normal text-foreground/42">{parentPath(fileRef.relativePath)}</span>
        </div>
        {(kind === 'markdown' || kind === 'html') && (
          <Button variant="ghost" size="sm" onClick={() => setSourceMode((value) => !value)}>
            {sourceMode ? '渲染' : '源码'}
          </Button>
        )}
        {kind === 'image' && <Button variant="ghost" size="sm" onClick={() => setImageOriginalSize((value) => !value)}>{imageOriginalSize ? '适应' : '原始尺寸'}</Button>}
        {payload && <Button variant="ghost" size="sm" onClick={() => void writeClipboardText(payload.content)}>复制内容</Button>}
        <Button variant="ghost" size="icon-sm" onClick={refresh} title="重新读取预览"><RotateCw size={14} /></Button>
        <Button variant="ghost" size="icon-sm" disabled={!desktop} onClick={() => void openFileRefInSystem(fileRef)} title={desktop ? '系统打开' : '仅桌面端可用'}><ExternalLink size={14} /></Button>
        <Button variant="ghost" size="icon-sm" disabled={!desktop} onClick={() => void revealFileRefInSystem(fileRef)} title={desktop ? '在资源管理器中显示' : '仅桌面端可用'}><FolderSearch size={14} /></Button>
        <Button variant="ghost" size="icon-sm" onClick={() => void writeClipboardText(fileRef.relativePath)} title="复制相对路径"><Copy size={14} /></Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {loading ? (
          <PreviewStatus>正在读取文件…</PreviewStatus>
        ) : error ? (
          <PreviewStatus>{error}</PreviewStatus>
        ) : kind === 'unsupported' ? (
          <PreviewStatus>
            此文件类型不支持内嵌预览，可使用系统应用打开。
            {metadata && <span className="mt-2 block text-[11px]">{metadata.size === undefined ? '大小未知' : formatBytes(metadata.size)} · {metadata.modifiedAt ? new Date(metadata.modifiedAt).toLocaleString() : '修改时间未知'}</span>}
          </PreviewStatus>
        ) : kind === 'image' ? (
          imageScope ? <img src={imageScope.url} alt={basename(fileRef.relativePath)} onError={() => setError('图片预览加载失败')} className={imageOriginalSize ? 'm-auto max-w-none' : 'm-auto max-h-full max-w-full object-contain'} /> : null
        ) : payload ? (
          <div className="h-full p-4">
            {payload.truncated && <p className="mb-3 text-[12px] text-amber-600">文件超过 512 KB，仅显示前 512 KB。</p>}
            {kind === 'html' && !sourceMode ? (
              <RightPanelHtmlPreview fileRef={fileRef} source={payload.content} onOpenFile={onOpenFile} onMissing={onMissing} onPreviewScopeChange={onPreviewScopeChange} />
            ) : kind === 'markdown' && !sourceMode ? (
              <XMarkdown className="x-markdown text-[13px] leading-6">{payload.content}</XMarkdown>
            ) : (
              <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-5">{payload.content}</pre>
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function PreviewStatus({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full min-h-48 items-center justify-center px-6 text-center text-[13px] text-foreground/55">{children}</div>
}

function basename(path: string) { return path.replace(/\\/g, '/').split('/').at(-1) ?? path }
function parentPath(path: string) { return path.replace(/\\/g, '/').split('/').slice(0, -1).join('/') }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : '读取文件失败' }
function formatBytes(size: number) {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${Math.round(size / 102.4) / 10} KB`
  return `${Math.round(size / 1024 / 102.4) / 10} MB`
}
