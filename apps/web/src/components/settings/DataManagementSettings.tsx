import * as React from 'react'
import {
  Download,
  FolderInput,
  FolderOpen,
  Loader2,
  RefreshCw,
  Trash2,
  TriangleAlert,
} from 'lucide-react'
import { toast } from 'sonner'
import { listen } from '@/lib/desktop-runtime/event'
import { relaunch } from '@/lib/desktop-runtime/process'
import { DATA_CATEGORY_META } from '@lume/shared'
import type { StorageStats } from '@lume/shared'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  applyMigration,
  clearCache,
  emptyTrash,
  exportZip,
  getStorageStats,
  migrateToDir,
  openFolderDialog,
  revealPathInSystem,
  saveFilePathDialog,
} from '@/lib/desktop-api'
import {
  CLEANUP_OPTIONS,
  createDefaultCleanupSelection,
  formatBytes,
  hasSelectedCleanup,
  type CleanupSelection,
} from './data-management-state'

export function DataManagementSettings() {
  const [stats, setStats] = React.useState<StorageStats | null>(null)
  const [loadingStats, setLoadingStats] = React.useState(true)
  const [selection, setSelection] = React.useState<CleanupSelection>(createDefaultCleanupSelection())
  const [clearing, setClearing] = React.useState(false)
  const [emptying, setEmptying] = React.useState(false)
  const [confirmEmptyOpen, setConfirmEmptyOpen] = React.useState(false)
  const [includeCreds, setIncludeCreds] = React.useState(false)
  const [exporting, setExporting] = React.useState(false)
  const [migrateOpen, setMigrateOpen] = React.useState(false)
  const [migrateDest, setMigrateDest] = React.useState<string | null>(null)
  const [migrating, setMigrating] = React.useState(false)
  const [migrateProgress, setMigrateProgress] = React.useState<{ done: number; total: number } | null>(null)
  const [migrateResult, setMigrateResult] = React.useState<{ destPath: string } | null>(null)
  const [migrateError, setMigrateError] = React.useState<string | null>(null)

  const refreshStats = React.useCallback(async () => {
    setLoadingStats(true)
    try {
      setStats(await getStorageStats())
    } catch (error) {
      console.error('[DataManagement] load stats FAILED:', error)
      toast.error('加载存储用量失败')
    } finally {
      setLoadingStats(false)
    }
  }, [])

  React.useEffect(() => {
    void refreshStats()
  }, [refreshStats])

  const unlistenRef = React.useRef<null | (() => void)>(null)
  React.useEffect(() => () => { unlistenRef.current?.(); unlistenRef.current = null }, [])

  const handleClear = async () => {
    setClearing(true)
    try {
      await clearCache(selection)
      toast.success('清理完成')
      await refreshStats()
    } catch (error) {
      console.error('[DataManagement] clear FAILED:', error)
      toast.error('清理失败')
    } finally {
      setClearing(false)
    }
  }

  const handleEmptyTrash = async () => {
    setEmptying(true)
    try {
      const { cleanedCount } = await emptyTrash()
      toast.success(`已清空回收站 ${cleanedCount} 项`)
      await refreshStats()
    } catch (error) {
      console.error('[DataManagement] emptyTrash FAILED:', error)
      toast.error('清空回收站失败')
    } finally {
      setEmptying(false)
      setConfirmEmptyOpen(false)
    }
  }

  const handleExport = async () => {
    setExporting(true)
    try {
      const picked = await saveFilePathDialog('lume-data.zip', [{ name: 'zip', extensions: ['zip'] }])
      if (!picked.path) return
      const result = await exportZip({ destPath: picked.path, includeCredentials: includeCreds })
      toast.success(`已导出 ${formatBytes(result.bytes)}（${result.fileCount} 个文件）`)
    } catch (error) {
      console.error('[DataManagement] export FAILED:', error)
      toast.error('导出失败')
    } finally {
      setExporting(false)
    }
  }

  const handleStartMigrate = async () => {
    setMigrating(true)
    setMigrateError(null)
    setMigrateProgress({ done: 0, total: 0 })
    const unlisten = await listen<{ done: number; total: number }>('data:migrate-progress', (e) => {
      setMigrateProgress(e.payload)
    })
    unlistenRef.current = unlisten
    try {
      if (!migrateDest) return
      const result = await migrateToDir(migrateDest)
      setMigrateResult({ destPath: result.destPath })
    } catch (error) {
      console.error('[DataManagement] migrate FAILED:', error)
      setMigrateError(error instanceof Error ? error.message : String(error))
    } finally {
      unlisten()
      unlistenRef.current = null
      setMigrating(false)
    }
  }

  const handleApplyMigrate = async (deleteOld: boolean) => {
    if (!migrateResult) return
    try {
      await applyMigration({ destPath: migrateResult.destPath, deleteOld })
      await relaunch()
    } catch (error) {
      console.error('[DataManagement] applyMigration FAILED:', error)
      toast.error('应用迁移失败，请手动重启')
    }
  }

  const pickMigrateDest = async () => {
    const picked = await openFolderDialog()
    if (picked.path) setMigrateDest(picked.path)
  }

  const totalBytes = stats?.total ?? 0

  return (
    <div className="space-y-3">
      {/* ① 存储概览 */}
      <section className="rounded-[10px] border border-[var(--border)] bg-[var(--surface-1)] px-5 py-4 shadow-[0_1px_2px_rgba(20,24,40,0.02)]">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[16px] font-semibold leading-6 text-[var(--text-1)]">存储概览</h2>
          <Button variant="outline" onClick={() => void refreshStats()} disabled={loadingStats} className="h-8 gap-1.5 rounded-[8px] px-3 text-[12px]">
            {loadingStats ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
            刷新
          </Button>
        </div>
        <div className="mb-3 text-[13px] text-[var(--text-2)]">
          总计 <span className="font-semibold text-[var(--text-1)]">{formatBytes(totalBytes)}</span>
        </div>
        <div className="space-y-2">
          {DATA_CATEGORY_META.map((meta) => {
            const bytes = stats?.categories.find((c) => c.key === meta.key)?.bytes ?? 0
            const pct = totalBytes > 0 ? Math.round((bytes / totalBytes) * 100) : 0
            return (
              <div key={meta.key} className="flex items-center gap-3">
                <div className="w-[72px] shrink-0 text-[13px] font-medium text-[var(--text-2)]">{meta.label}</div>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--surface-2)]">
                  <div className="h-full rounded-full bg-[var(--brand)]" style={{ width: `${pct}%` }} />
                </div>
                <div className="w-[64px] shrink-0 text-right text-[12px] tabular-nums text-[var(--text-2)]">{formatBytes(bytes)}</div>
                <div className="w-[40px] shrink-0 text-right text-[11px] tabular-nums text-[var(--text-3)]">{pct}%</div>
              </div>
            )
          })}
        </div>
        <p className="mt-3 text-[11px] leading-4 text-[var(--text-3)]">
          {DATA_CATEGORY_META.map((m) => `${m.label}：${m.subtitle}`).join('；')}
        </p>
      </section>

      {/* ② 清理 */}
      <section className="rounded-[10px] border border-[var(--border)] bg-[var(--surface-1)] px-5 py-4 shadow-[0_1px_2px_rgba(20,24,40,0.02)]">
        <h2 className="mb-3 text-[16px] font-semibold leading-6 text-[var(--text-1)]">清理</h2>
        <div className="space-y-2">
          {CLEANUP_OPTIONS.map((option) => (
            <label key={option.key} className="flex items-center gap-3 rounded-[8px] border border-[var(--border)] px-3 py-2">
              <input
                type="checkbox"
                checked={selection[option.key]}
                onChange={(e) => setSelection((cur) => ({ ...cur, [option.key]: e.currentTarget.checked }))}
                disabled={clearing}
                className="size-4 accent-[var(--brand)]"
              />
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium text-[var(--text-2)]">{option.label}</div>
                <div className="text-[11px] text-[var(--text-3)]">{option.desc}</div>
              </div>
              <span className="text-[11px] text-[var(--text-3)]">可重建</span>
            </label>
          ))}
        </div>
        <div className="mt-3 flex items-center justify-between gap-3">
          <span className="text-[11px] text-[var(--text-3)]">以上均为可重建数据，清理后不影响会话与记忆。</span>
          <Button onClick={handleClear} disabled={clearing || !hasSelectedCleanup(selection)} className="h-9 gap-1.5 rounded-[8px] px-4 text-[13px]">
            {clearing ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
            执行清理
          </Button>
        </div>
      </section>

      {/* ③ 导出 */}
      <section className="rounded-[10px] border border-[var(--border)] bg-[var(--surface-1)] px-5 py-4 shadow-[0_1px_2px_rgba(20,24,40,0.02)]">
        <h2 className="mb-3 text-[16px] font-semibold leading-6 text-[var(--text-1)]">导出</h2>
        <p className="mb-3 text-[12px] leading-5 text-[var(--text-3)]">
          将 <code className="rounded bg-[var(--surface-2)] px-1">~/.lume/</code> 打包为 zip。默认对所有配置 JSON 做凭证脱敏。
        </p>
        <label className="mb-3 flex items-center gap-2 rounded-[8px] border border-amber-500/30 bg-amber-500/5 px-3 py-2">
          <input
            type="checkbox"
            checked={includeCreds}
            onChange={(e) => setIncludeCreds(e.currentTarget.checked)}
            disabled={exporting}
            className="size-4 accent-amber-600"
          />
          <span className="flex items-center gap-1 text-[12px] text-amber-800 dark:text-amber-200">
            <TriangleAlert size={13} />
            包含凭证（API Key / Token / IM 凭证将以明文导出）
          </span>
        </label>
        <div className="flex justify-end">
          <Button onClick={handleExport} disabled={exporting} className="h-9 gap-1.5 rounded-[8px] px-4 text-[13px]">
            {exporting ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
            选择位置并导出
          </Button>
        </div>
      </section>

      {/* ④ 数据位置 */}
      <section className="rounded-[10px] border border-[var(--border)] bg-[var(--surface-1)] px-5 py-4 shadow-[0_1px_2px_rgba(20,24,40,0.02)]">
        <h2 className="mb-3 text-[16px] font-semibold leading-6 text-[var(--text-1)]">数据位置</h2>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 text-[13px] text-[var(--text-2)]">
            根目录 <code className="break-all rounded bg-[var(--surface-2)] px-1">{stats?.configDir ?? '~/.lume/'}</code>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button
              variant="outline"
              disabled={!stats?.configDir}
              onClick={() => stats?.configDir && revealPathInSystem(stats.configDir).catch(() => toast.error('打开目录失败'))}
              className="h-8 gap-1.5 rounded-[8px] px-3 text-[12px]"
            >
              <FolderOpen size={13} />
              打开目录
            </Button>
            <Button
              variant="outline"
              onClick={() => { setMigrateOpen(true); setMigrateResult(null); setMigrateError(null); setMigrateDest(null); setMigrateProgress(null); setMigrating(false) }}
              className="h-8 gap-1.5 rounded-[8px] px-3 text-[12px]"
            >
              <FolderInput size={13} />
              迁移目录
            </Button>
          </div>
        </div>
        <p className="mt-2 text-[11px] leading-4 text-[var(--text-3)]">
          所有数据均为本地文件：记忆是 Markdown、会话是 jsonl、向量索引是 JSON 缓存。配置类文件含凭证，导出时默认脱敏。
        </p>
      </section>

      {/* 清空回收站（危险，独立折叠） */}
      <section className="rounded-[10px] border border-[#ff9fa8] bg-[var(--surface-1)] px-5 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="flex items-center gap-1.5 text-[15px] font-semibold text-[#ff4d57]">
              <Trash2 size={15} />
              清空回收站
            </h2>
            <p className="mt-1 text-[11px] text-[var(--text-3)]">永久删除所有已放入回收站的会话，不可恢复。</p>
          </div>
          <Button
            onClick={() => setConfirmEmptyOpen(true)}
            disabled={emptying}
            className="h-9 gap-1.5 rounded-[8px] border border-[#ff9fa8] bg-[#fff5f6] px-4 text-[13px] text-[#ff4d57] hover:bg-[#ffe9eb]"
          >
            清空回收站
          </Button>
        </div>

        {confirmEmptyOpen && (
          <div className="mt-3 rounded-[8px] border border-[#ff9fa8] bg-[#fff5f6] px-3 py-3">
            <p className="text-[12px] text-[#ff4d57]">确认永久删除回收站中的全部会话？此操作不可撤销。</p>
            <div className="mt-2 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setConfirmEmptyOpen(false)} disabled={emptying} className="h-8 rounded-[8px] px-3 text-[12px]">取消</Button>
              <Button onClick={handleEmptyTrash} disabled={emptying} className="h-8 gap-1.5 rounded-[8px] bg-[#ff4d57] px-3 text-[12px] text-white hover:bg-[#e6454f]">
                {emptying ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                确认清空
              </Button>
            </div>
          </div>
        )}
      </section>

      <Dialog
        open={migrateOpen}
        onOpenChange={(open) => {
          // 仅 idle 态（未在复制、未到成功选择）允许关闭；迁移中与成功态强制保留（sidecar 已 kill，必须走到重启）
          if (!open && !migrateResult && !migrating) setMigrateOpen(false)
        }}
      >
        <DialogContent showCloseButton={false} className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>迁移数据目录</DialogTitle>
          </DialogHeader>

          {!migrateResult ? (
            <div className="space-y-3">
              <DialogDescription>
                将复制全部数据到新位置，完成后自动重启。旧目录可在完成后删除或保留。
              </DialogDescription>
              <div className="flex items-center gap-2">
                <Button variant="outline" onClick={pickMigrateDest} disabled={migrating} className="h-8 shrink-0 rounded-[8px] px-3 text-[12px]">
                  选择目标目录
                </Button>
                <code className="min-w-0 flex-1 truncate rounded bg-[var(--surface-2)] px-2 py-1 text-[11px] text-[var(--text-2)]">
                  {migrateDest ?? '未选择'}
                </code>
              </div>
              {migrateProgress && migrating && (
                <div className="text-[11px] text-[var(--text-3)]">
                  正在复制 {migrateProgress.done}/{migrateProgress.total || '?'} …
                </div>
              )}
              {migrateError && (
                <div className="rounded-[8px] border border-[#ff9fa8] bg-[#fff5f6] px-3 py-2 text-[12px] text-[#ff4d57]">
                  迁移失败：{migrateError}。旧目录未改动，建议重启应用以恢复。
                </div>
              )}
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setMigrateOpen(false)} disabled={migrating} className="h-8 rounded-[8px] px-3 text-[12px]">
                  取消
                </Button>
                {migrateError ? (
                  <Button onClick={() => void relaunch()} className="h-8 rounded-[8px] px-3 text-[12px]">
                    重启恢复
                  </Button>
                ) : (
                  <Button onClick={handleStartMigrate} disabled={!migrateDest || migrating} className="h-8 rounded-[8px] px-3 text-[12px]">
                    {migrating ? '复制中…' : '开始迁移'}
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <DialogDescription>
                迁移完成。选择旧目录的处理方式后将自动重启。
              </DialogDescription>
              <div className="flex justify-end gap-2">
                <Button onClick={() => void handleApplyMigrate(true)} className="h-8 rounded-[8px] border border-[#ff9fa8] bg-[#fff5f6] px-3 text-[12px] text-[#ff4d57] hover:bg-[#ffe9eb]">
                  删除旧目录
                </Button>
                <Button onClick={() => void handleApplyMigrate(false)} className="h-8 rounded-[8px] px-3 text-[12px]">
                  保留作备份
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
