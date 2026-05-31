import * as React from 'react'
import {
  Download,
  FolderOpen,
  Loader2,
  RefreshCw,
  Search,
} from 'lucide-react'
import { toast } from 'sonner'
import type {
  LogFileListResult,
  LogFileSummary,
  LogLineEntry,
  LogViewerLevel,
  ReadLogFileResult,
} from '@lume/shared'
import { Button } from '@/components/ui/button'
import { exportLogs, listLogFiles, openLogsDir, readLogFile } from '@/lib/desktop-api'
import { cn } from '@/lib/utils'

const LEVEL_OPTIONS: Array<{ value: 'all' | LogViewerLevel; label: string }> = [
  { value: 'all', label: '全部级别' },
  { value: 'trace', label: 'Trace' },
  { value: 'debug', label: 'Debug' },
  { value: 'info', label: 'Info' },
  { value: 'warn', label: 'Warn' },
  { value: 'error', label: 'Error' },
  { value: 'fatal', label: 'Fatal' },
]

export function LogSettings() {
  const [snapshot, setSnapshot] = React.useState<LogFileListResult | null>(null)
  const [selectedFileName, setSelectedFileName] = React.useState('')
  const [level, setLevel] = React.useState<'all' | LogViewerLevel>('all')
  const [query, setQuery] = React.useState('')
  const [content, setContent] = React.useState<ReadLogFileResult | null>(null)
  const [loadingFiles, setLoadingFiles] = React.useState(true)
  const [loadingContent, setLoadingContent] = React.useState(false)
  const [exporting, setExporting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [contentRefreshKey, setContentRefreshKey] = React.useState(0)

  const selectedFile = React.useMemo(
    () => snapshot?.files.find((file) => file.name === selectedFileName) ?? null,
    [selectedFileName, snapshot]
  )

  const refreshFiles = React.useCallback(async () => {
    setLoadingFiles(true)
    setError(null)
    try {
      const result = await listLogFiles()
      setSnapshot(result)
      setSelectedFileName((current) => {
        if (current && result.files.some((file) => file.name === current)) return current
        return result.files[0]?.name ?? ''
      })
      setContentRefreshKey((k) => k + 1)
    } catch (loadError) {
      console.error('[LogSettings] load files FAILED:', loadError)
      setError('加载日志文件失败')
      toast.error('加载日志文件失败')
    } finally {
      setLoadingFiles(false)
    }
  }, [])

  React.useEffect(() => {
    void refreshFiles()
  }, [refreshFiles])

  React.useEffect(() => {
    if (!selectedFileName) {
      setContent(null)
      return
    }

    let cancelled = false
    setLoadingContent(true)
    setError(null)
    readLogFile({
      fileName: selectedFileName,
      levels: level === 'all' ? undefined : [level],
      query: query.trim() || undefined,
      maxLines: 5000,
    })
      .then((result) => {
        if (!cancelled) {
          setContent(result)
        }
      })
      .catch((readError) => {
        if (cancelled) return
        console.error('[LogSettings] read file FAILED:', readError)
        setError('读取日志内容失败')
        toast.error('读取日志内容失败')
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingContent(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [contentRefreshKey, level, query, selectedFileName])

  const handleOpenDir = async () => {
    try {
      await openLogsDir()
    } catch (openError) {
      console.error('[LogSettings] open logs dir FAILED:', openError)
      toast.error('打开日志目录失败')
    }
  }

  const handleExport = async () => {
    setExporting(true)
    try {
      const result = await exportLogs()
      toast.success(`已导出 ${result.fileName}`)
    } catch (exportError) {
      console.error('[LogSettings] export logs FAILED:', exportError)
      toast.error('导出日志失败')
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-[20px] font-semibold leading-7 text-[var(--text-1)]">应用日志</h3>
          <p className="mt-1 text-[13px] leading-5 text-[var(--text-2)]">
            所有运行日志按日期存储在本地文件，共 {snapshot?.totalFiles ?? 0} 个文件，{formatBytes(snapshot?.totalBytes ?? 0)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => void refreshFiles()} disabled={loadingFiles}>
            <RefreshCw size={14} className={cn(loadingFiles && 'animate-spin')} />
            刷新
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => void handleOpenDir()}>
            <FolderOpen size={14} />
            打开目录
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => void handleExport()} disabled={exporting || !snapshot?.totalFiles}>
            {exporting ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
            导出全部
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <SelectShell className="w-[304px]">
          <select
            value={selectedFileName}
            onChange={(event) => setSelectedFileName(event.target.value)}
            className="h-full w-full appearance-none bg-transparent px-4 pr-9 text-[14px] font-medium text-[var(--text-1)] outline-none"
            disabled={loadingFiles || !snapshot?.files.length}
          >
            {snapshot?.files.length ? snapshot.files.map((file) => (
              <option key={file.name} value={file.name}>
                {file.name} ({formatBytes(file.sizeBytes)})
              </option>
            )) : (
              <option value="">暂无日志文件</option>
            )}
          </select>
        </SelectShell>

        <SelectShell className="w-[140px]">
          <select
            value={level}
            onChange={(event) => setLevel(event.target.value as 'all' | LogViewerLevel)}
            className="h-full w-full appearance-none bg-transparent px-4 pr-9 text-[14px] font-medium text-[var(--text-1)] outline-none"
          >
            {LEVEL_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </SelectShell>

        <div className="flex h-[46px] min-w-[260px] flex-1 items-center gap-2 rounded-[10px] border border-[var(--border)] bg-[var(--surface-1)] px-4">
          <Search size={16} className="shrink-0 text-[var(--text-3)]" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索日志内容..."
            className="min-w-0 flex-1 bg-transparent text-[14px] text-[var(--text-1)] outline-none placeholder:text-[var(--text-3)]"
          />
        </div>
      </div>

      <div className="overflow-hidden rounded-[12px] border border-[var(--border)] bg-[var(--surface-2)]">
        <div className="flex h-[48px] items-center justify-between border-b border-[var(--border)] px-5 text-[13px] text-[var(--text-2)]">
          <span>
            {content ? `显示 ${content.matchedLines} / ${content.totalLines} 行` : loadingFiles ? '加载日志文件...' : '未选择日志文件'}
          </span>
          {selectedFile && <span>{formatLogFileMeta(selectedFile)}</span>}
        </div>
        <div className="h-[560px] overflow-auto px-5 py-4 font-mono text-[13px] leading-7 text-[var(--text-1)]">
          {loadingContent ? (
            <div className="flex h-full items-center justify-center text-[var(--text-3)]">
              <Loader2 size={15} className="mr-2 animate-spin" />
              加载日志内容...
            </div>
          ) : error ? (
            <div className="flex h-full items-center justify-center text-[var(--danger)]">{error}</div>
          ) : content?.lines.length ? (
            content.lines.slice().reverse().map((line) => <LogLine key={`${line.lineNumber}:${line.text}`} line={line} />)
          ) : (
            <div className="flex h-full items-center justify-center text-[var(--text-3)]">
              {selectedFileName ? '没有匹配的日志内容' : '暂无日志文件'}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function LogLine({ line }: { line: LogLineEntry }) {
  return (
    <div className="mb-2">
      <div
        className={cn(
          'whitespace-pre-wrap break-words',
          line.level === 'warn' && 'text-amber-600',
          (line.level === 'error' || line.level === 'fatal') && 'text-red-600',
          line.level === 'debug' && 'text-[var(--text-2)]',
          line.level === 'trace' && 'text-[var(--text-3)]'
        )}
      >
        {line.text}
      </div>
    </div>
  )
}

function SelectShell({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={cn('relative h-[46px] rounded-[10px] border border-[var(--border)] bg-[var(--surface-1)]', className)}>
      {children}
      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[var(--text-3)]">⌄</span>
    </div>
  )
}

function formatLogFileMeta(file: LogFileSummary): string {
  return `${formatBytes(file.sizeBytes)} · ${new Date(file.modifiedAt).toLocaleString()}`
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(kb >= 10 ? 0 : 1)} KB`
  const mb = kb / 1024
  return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`
}
