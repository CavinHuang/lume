import * as React from 'react'
import {
  ChevronDown,
  Copy,
  Download,
  FolderOpen,
  Loader2,
  RefreshCw,
  Search,
  Radio,
  Pause,
  Trash2,
  ShieldCheck,
} from 'lucide-react'
import { toast } from 'sonner'
import type {
  LogFileListResult,
  LogFileSummary,
  LogViewerLevel,
  ReadLogFileResult,
  ReadLogFileInput,
  LumeLogEventV2,
  LumeDiagnosticStatus,
  LumeLoggingSettings,
} from '@lume/shared'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  decryptDiagnosticContent,
  deleteDiagnosticContent,
  deleteLogs,
  exportLogs,
  getDiagnosticStatus,
  getGeneralSettings,
  listLogFiles,
  openLogsDir,
  readLogFile,
  startDiagnosticCapture,
  stopDiagnosticCapture,
  subscribeLiveLogs,
  writeClipboardText,
  updateGeneralSettings,
} from '@/lib/desktop-api'
import { cn } from '@/lib/utils'

import { Input } from '@/components/ui/input'
const LEVEL_OPTIONS: Array<{ value: 'all' | LogViewerLevel; label: string }> = [
  { value: 'all', label: '全部级别' },
  { value: 'trace', label: 'Trace' },
  { value: 'debug', label: 'Debug' },
  { value: 'info', label: 'Info' },
  { value: 'warn', label: 'Warn' },
  { value: 'error', label: 'Error' },
  { value: 'fatal', label: 'Fatal' },
]

const PAGE_SIZE = 300

const SOURCE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'all', label: '全部来源' },
  { value: 'main', label: 'Main' },
  { value: 'sidecar', label: 'Sidecar' },
  { value: 'renderer', label: 'Renderer' },
  { value: 'desktop-host', label: 'Desktop Host' },
  { value: 'node-repl', label: 'Node REPL' },
]

/** Extended log line that may include raw_json from Desktop direct read */
interface LogLineEntryExt {
  lineNumber: number
  fileName?: string
  level: LogViewerLevel
  text: string
  rawJson?: string
  event?: LumeLogEventV2
}

export function LogSettings() {
  const [snapshot, setSnapshot] = React.useState<LogFileListResult | null>(null)
  const [selectedFileName, setSelectedFileName] = React.useState('')
  const [level, setLevel] = React.useState<'all' | LogViewerLevel>('all')
  const [source, setSource] = React.useState('all')
  const [query, setQuery] = React.useState('')
  const [content, setContent] = React.useState<ReadLogFileResult | null>(null)
  const [loadingFiles, setLoadingFiles] = React.useState(true)
  const [loadingContent, setLoadingContent] = React.useState(false)
  const [exporting, setExporting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [contentRefreshKey, setContentRefreshKey] = React.useState(0)
  const [showRawJson, setShowRawJson] = React.useState(false)
  const [loadedLimit, setLoadedLimit] = React.useState(PAGE_SIZE)
  const [selectedTraceId, setSelectedTraceId] = React.useState('')
  const [livePaused, setLivePaused] = React.useState(false)
  const [diagnosticStatus, setDiagnosticStatus] = React.useState<LumeDiagnosticStatus | null>(null)
  const [diagnosticThreadId, setDiagnosticThreadId] = React.useState('')
  const [diagnosticMinutes, setDiagnosticMinutes] = React.useState('60')
  const [loggingSettings, setLoggingSettings] = React.useState<LumeLoggingSettings | null>(null)
  const livePausedRef = React.useRef(false)
  const liveRefreshTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  React.useEffect(() => { livePausedRef.current = livePaused }, [livePaused])

  React.useEffect(() => {
    void getDiagnosticStatus().then(setDiagnosticStatus).catch(() => {})
    void getGeneralSettings().then((settings) => setLoggingSettings(settings.logging)).catch(() => {})
  }, [])

  const saveLoggingSettings = async (updates: Partial<LumeLoggingSettings>) => {
    if (!loggingSettings) return
    const optimistic = { ...loggingSettings, ...updates }
    setLoggingSettings(optimistic)
    try {
      const settings = await updateGeneralSettings({ logging: updates })
      setLoggingSettings(settings.logging)
    } catch {
      setLoggingSettings(loggingSettings)
      toast.error('保存日志设置失败')
    }
  }

  // #753: 仅单文件跟随——' * '（全目录）跟随会退化为 250ms 全量重扫，随历史累积线性恶化。
  const liveFollowEligible = selectedFileName !== '' && selectedFileName !== '*'
  const liveFollowRef = React.useRef(liveFollowEligible)
  React.useEffect(() => { liveFollowRef.current = liveFollowEligible }, [liveFollowEligible])

  React.useEffect(() => {
    if (!liveFollowEligible) return
    let disposed = false
    let unsubscribe: (() => Promise<void>) | undefined
    void subscribeLiveLogs(() => {
      if (livePausedRef.current || !liveFollowRef.current || liveRefreshTimer.current) return
      liveRefreshTimer.current = setTimeout(() => {
        liveRefreshTimer.current = null
        setContentRefreshKey((key) => key + 1)
      }, 250)
    }).then((off) => {
      if (disposed) {
        void off()
        return
      }
      unsubscribe = off
    }).catch(() => {})
    return () => {
      disposed = true
      if (liveRefreshTimer.current) {
        clearTimeout(liveRefreshTimer.current)
        liveRefreshTimer.current = null
      }
      void unsubscribe?.()
    }
  }, [liveFollowEligible])

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
        return result.files.length ? '*' : ''
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

  // Build keyword from source filter + user query
  const effectiveKeyword = React.useMemo(() => {
    const parts: string[] = []
    if (query.trim()) parts.push(query.trim())
    return parts.join(' ') || undefined
  }, [query])

  // Reset limit when file/filter changes
  React.useEffect(() => {
    setLoadedLimit(PAGE_SIZE)
  }, [selectedFileName, level, effectiveKeyword])

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
      query: effectiveKeyword,
      maxLines: loadedLimit,
      source: source === 'all' ? undefined : source as ReadLogFileInput['source'],
      traceId: selectedTraceId || undefined,
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
  }, [contentRefreshKey, level, effectiveKeyword, selectedFileName, loadedLimit, source, selectedTraceId])

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

  const handleDeleteLogs = async () => {
    if (!window.confirm('确定删除全部普通日志吗？诊断密文不会被删除。')) return
    const result = await deleteLogs()
    toast.success(`已删除 ${result.deleted} 个日志分段`)
    await refreshFiles()
  }

  const handleStartDiagnostic = async () => {
    try {
      const result = await startDiagnosticCapture({
        ...(selectedTraceId ? { traceId: selectedTraceId } : { threadId: diagnosticThreadId.trim() }),
        durationMinutes: Number(diagnosticMinutes),
      })
      setDiagnosticStatus(result)
      toast.success('诊断正文捕获已开启')
    } catch (captureError) {
      toast.error(captureError instanceof Error ? captureError.message : '无法开启诊断正文捕获')
    }
  }

  const handleStopDiagnostic = async (deleteContent: boolean) => {
    try {
      const result = await stopDiagnosticCapture(deleteContent)
      setDiagnosticStatus(result)
      toast.success(deleteContent ? '已停止捕获并删除诊断密文' : '已停止诊断正文捕获')
    } catch {
      toast.error('停止诊断正文捕获失败')
    }
  }

  // Cast lines to extended type — Desktop direct read includes raw_json
  const lines = (content?.lines ?? []) as unknown as LogLineEntryExt[]
  const hasMore = content ? content.matchedLines > lines.length : false
  const traceSummary = React.useMemo(() => {
    const events = lines.map((line) => line.event).filter((event): event is LumeLogEventV2 => Boolean(event))
    const model = events.find((event) => event.event === 'model.resolved')?.data
    const completed = [...events].reverse().find((event) => event.event === 'agent.run.completed' || event.event === 'agent.run.failed' || event.event === 'reply.committed')
    const startedAt = events[0]?.observedAt
    const endedAt = events.at(-1)?.observedAt
    const durationMs = startedAt && endedAt ? Date.parse(endedAt) - Date.parse(startedAt) : undefined
    return {
      provider: typeof model?.provider === 'string' ? model.provider : undefined,
      modelId: typeof model?.modelId === 'string' ? model.modelId : undefined,
      status: completed?.status,
      durationMs,
      eventCount: events.length,
    }
  }, [lines])

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[13px] leading-5 text-[var(--text-2)]">
            所有运行日志按日期存储在本地文件，共 {snapshot?.totalFiles ?? 0} 个文件，{formatBytes(snapshot?.totalBytes ?? 0)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => void refreshFiles()} disabled={loadingFiles}>
            <RefreshCw size={14} className={cn(loadingFiles && 'animate-spin')} />
            刷新
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setLivePaused((value) => !value)}
            disabled={!liveFollowEligible}
            title={!liveFollowEligible ? '选择单个日志文件后启用实时跟随' : undefined}
          >
            {livePaused ? <Radio size={14} /> : <Pause size={14} />}
            {livePaused ? '继续实时跟随' : '暂停实时跟随'}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => void handleOpenDir()}>
            <FolderOpen size={14} />
            打开目录
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => void handleExport()} disabled={exporting || !snapshot?.totalFiles}>
            {exporting ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
            导出全部
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => void handleDeleteLogs()} disabled={!snapshot?.totalFiles}>
            <Trash2 size={14} />
            清空普通日志
          </Button>
        </div>
      </div>

      {selectedTraceId && (
        <div className="flex items-center justify-between rounded-[10px] border border-[var(--border)] bg-[var(--surface-1)] px-4 py-2 text-[13px]">
          <div>
            <span className="font-mono text-[var(--text-2)]">当前 trace：{selectedTraceId}</span>
            <div className="mt-1 text-[12px] text-[var(--text-3)]">
              {traceSummary.provider ?? 'provider unknown'} / {traceSummary.modelId ?? 'model unknown'} · {traceSummary.status ?? 'running/unknown'} · {traceSummary.eventCount} events
              {Number.isFinite(traceSummary.durationMs) ? ` · ${traceSummary.durationMs} ms` : ''}
            </div>
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={() => setSelectedTraceId('')}>查看全部</Button>
        </div>
      )}

      <div className="rounded-[12px] border border-[var(--border)] bg-[var(--surface-1)] p-4">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-[14px] font-medium text-[var(--text-1)]">
              <ShieldCheck size={16} />
              诊断正文捕获
            </div>
            <p className="mt-1 text-[12px] leading-5 text-[var(--text-3)]">
              仅捕获指定 thread 或当前 trace 的用户与 Agent 正文，使用系统安全存储加密；最长 24 小时，普通导出不包含正文。
            </p>
          </div>
          <span className="text-[12px] text-[var(--text-3)]">
            {!diagnosticStatus?.available ? '系统安全存储不可用' : diagnosticStatus.lease?.enabled ? `有效至 ${new Date(diagnosticStatus.lease.expiresAt!).toLocaleString()}` : '未开启'}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={selectedTraceId || diagnosticThreadId}
            onChange={(event) => setDiagnosticThreadId(event.target.value)}
            disabled={Boolean(selectedTraceId) || diagnosticStatus?.lease?.enabled}
            placeholder={selectedTraceId ? '使用当前 trace' : '输入 threadId'}
            className="h-9 min-w-[280px] flex-1"
          />
          <Select value={diagnosticMinutes} onValueChange={(value) => value && setDiagnosticMinutes(value)} disabled={diagnosticStatus?.lease?.enabled}>
            <SelectTrigger className="h-9 w-[130px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="60">1 小时</SelectItem>
              <SelectItem value="360">6 小时</SelectItem>
              <SelectItem value="1440">24 小时</SelectItem>
            </SelectContent>
          </Select>
          {diagnosticStatus?.lease?.enabled ? (
            <>
              <Button type="button" variant="outline" size="sm" onClick={() => void handleStopDiagnostic(false)}>停止</Button>
              <Button type="button" variant="destructive" size="sm" onClick={() => void handleStopDiagnostic(true)}>停止并删除</Button>
            </>
          ) : (
            <Button type="button" variant="outline" size="sm" disabled={!diagnosticStatus?.available || (!selectedTraceId && !diagnosticThreadId.trim())} onClick={() => void handleStartDiagnostic()}>
              开启捕获
            </Button>
          )}
          <Button type="button" variant="ghost" size="sm" onClick={() => void deleteDiagnosticContent().then((result) => toast.success(`已删除 ${result.deleted} 条诊断密文`))}>
            删除全部密文
          </Button>
        </div>
      </div>

      {loggingSettings && (
        <div className="rounded-[12px] border border-[var(--border)] bg-[var(--surface-1)] p-4">
          <div className="mb-3 text-[14px] font-medium text-[var(--text-1)]">日志策略</div>
          <div className="grid gap-3 md:grid-cols-3">
            <label className="space-y-1 text-[12px] text-[var(--text-3)]">
              <span>终端级别</span>
              <Select value={loggingSettings.consoleLevel} onValueChange={(value) => value && void saveLoggingSettings({ consoleLevel: value as LumeLoggingSettings['consoleLevel'] })}>
                <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                <SelectContent>{LEVEL_OPTIONS.filter((item) => item.value !== 'all').map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent>
              </Select>
            </label>
            <label className="space-y-1 text-[12px] text-[var(--text-3)]">
              <span>普通文件级别（业务 trace 始终保留）</span>
              <Select value={loggingSettings.fileLevel} onValueChange={(value) => value && void saveLoggingSettings({ fileLevel: value as LumeLoggingSettings['fileLevel'] })}>
                <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                <SelectContent>{LEVEL_OPTIONS.filter((item) => item.value !== 'all').map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent>
              </Select>
            </label>
            <label className="space-y-1 text-[12px] text-[var(--text-3)]">
              <span>保留天数（1–365）</span>
              <Input
                type="number"
                min={1}
                max={365}
                value={loggingSettings.retentionDays}
                onChange={(event) => setLoggingSettings({ ...loggingSettings, retentionDays: Number(event.target.value) })}
                onBlur={() => void saveLoggingSettings({ retentionDays: loggingSettings.retentionDays })}
                className="h-9"
              />
            </label>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Select
          value={selectedFileName || '__none__'}
          onValueChange={(value) => setSelectedFileName(value && value !== '__none__' ? value : '')}
          disabled={loadingFiles || !snapshot?.files.length}
        >
          <SelectTrigger className="h-[46px] w-[304px] border-[color:color-mix(in_oklab,var(--border)_78%,transparent)] bg-[var(--surface-1)] px-4 text-[14px] font-medium text-[var(--text-1)] shadow-none focus-visible:ring-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {snapshot?.files.length ? (
              <>
                <SelectItem value="*">所有日志文件 ({snapshot.totalFiles})</SelectItem>
                {snapshot.files.map((file) => (
                  <SelectItem key={file.name} value={file.name}>
                    {file.name} ({formatBytes(file.sizeBytes)})
                  </SelectItem>
                ))}
              </>
            ) : (
              <SelectItem value="__none__">暂无日志文件</SelectItem>
            )}
          </SelectContent>
        </Select>

        <Select value={level} onValueChange={(value) => { if (value) setLevel(value as 'all' | LogViewerLevel) }}>
          <SelectTrigger className="h-[46px] w-[140px] border-[color:color-mix(in_oklab,var(--border)_78%,transparent)] bg-[var(--surface-1)] px-4 text-[14px] font-medium text-[var(--text-1)] shadow-none focus-visible:ring-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LEVEL_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={source} onValueChange={(value) => { if (value) setSource(value) }}>
          <SelectTrigger className="h-[46px] w-[140px] border-[color:color-mix(in_oklab,var(--border)_78%,transparent)] bg-[var(--surface-1)] px-4 text-[14px] font-medium text-[var(--text-1)] shadow-none focus-visible:ring-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SOURCE_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="lume-panel flex h-[46px] min-w-[260px] flex-1 items-center gap-2 px-4">
          <Search size={16} className="shrink-0 text-[var(--text-3)]" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索日志内容..."
            className="h-full min-w-0 flex-1 border-0 bg-transparent px-0 text-[14px] text-[var(--text-1)] shadow-none outline-none placeholder:text-[var(--text-3)] focus-visible:ring-0"
          />
        </div>

        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn('text-[13px]', showRawJson && 'text-[var(--primary)]')}
          onClick={() => setShowRawJson((v) => !v)}
        >
          {showRawJson ? '{ } JSON' : '{ } JSON'}
        </Button>
      </div>

      <div className="overflow-hidden rounded-[12px] border border-[var(--border)] bg-[var(--surface-2)]">
        <div className="flex h-[48px] items-center justify-between border-b border-[var(--border)] px-5 text-[13px] text-[var(--text-2)]">
          <span>
            {content ? `已加载 ${lines.length} / ${content.matchedLines} 条匹配（共 ${content.totalLines} 行）` : loadingFiles ? '加载日志文件...' : '未选择日志文件'}
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
          ) : lines.length ? (
            <>
              {lines.slice().reverse().map((line) => (
                <LogLine key={`${line.fileName ?? selectedFileName}:${line.lineNumber}:${line.text}`} line={line} showRawJson={showRawJson} onSelectTrace={setSelectedTraceId} />
              ))}
              {hasMore && (
                <div className="flex justify-center py-4">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-[13px] text-[var(--text-3)]"
                    onClick={() => setLoadedLimit((n) => n + PAGE_SIZE)}
                  >
                    <ChevronDown size={14} />
                    加载更多（剩余 {content!.matchedLines - lines.length} 条）
                  </Button>
                </div>
              )}
            </>
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

function LogLine({ line, showRawJson, onSelectTrace }: { line: LogLineEntryExt; showRawJson: boolean; onSelectTrace: (traceId: string) => void }) {
  const [copied, setCopied] = React.useState(false)
  const [diagnosticContent, setDiagnosticContent] = React.useState('')

  const handleCopy = () => {
    const text = showRawJson && line.rawJson ? line.rawJson : line.text
    writeClipboardText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }).catch(() => toast.error('复制日志失败'))
  }

  const displayText = showRawJson && line.rawJson ? line.rawJson : line.text

  return (
    <div className="group relative mb-2">
      <div
        className={cn(
          'whitespace-pre-wrap break-words pr-8',
          line.level === 'warn' && 'text-amber-600',
          (line.level === 'error' || line.level === 'fatal') && 'text-red-600',
          line.level === 'debug' && 'text-[var(--text-2)]',
          line.level === 'trace' && 'text-[var(--text-3)]'
        )}
      >
        {line.fileName && <span className="mr-2 text-[var(--text-3)]">[{line.fileName}]</span>}
        {displayText}
      </div>
      {!showRawJson && line.event?.traceId && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mt-1 h-6 px-2 font-mono text-[11px] text-[var(--text-3)]"
          onClick={() => onSelectTrace(line.event!.traceId!)}
        >
          trace {line.event.traceId.slice(0, 8)} · {line.event.source} · {line.event.status ?? 'event'}
        </Button>
      )}
      {!showRawJson && line.event?.event === 'diagnostic.content_captured' && typeof line.event.data?.recordId === 'string' && (
        <div className="mt-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void decryptDiagnosticContent(line.event!.data!.recordId as string)
              .then((result) => setDiagnosticContent(result.content))
              .catch(() => toast.error('诊断正文已过期或无法解密'))}
          >
            按需解密正文
          </Button>
          {diagnosticContent && <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-[8px] bg-[var(--surface-1)] p-3 font-sans text-[13px]">{diagnosticContent}</pre>}
        </div>
      )}
      <Button
                variant="ghost"
        type="button"
        onClick={handleCopy}
        className="absolute right-0 top-0 hidden p-1 text-[var(--text-3)] opacity-0 transition-opacity hover:text-[var(--text-1)] group-hover:block group-hover:opacity-100"
        title="复制此行"
      >
        {copied ? <span className="text-[11px] text-green-600">✓</span> : <Copy size={13} />}
      </Button>
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
