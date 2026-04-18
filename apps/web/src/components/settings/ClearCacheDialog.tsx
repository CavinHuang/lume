import * as React from 'react'
import { CheckCircle2, Loader2, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { clearCache, type ClearCacheResult } from '@/lib/desktop-api'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import {
  CACHE_CLEANUP_OPTIONS,
  createDefaultCacheCleanupSelection,
  hasSelectedCacheCleanup,
  type CacheCleanupKey,
  type CacheCleanupSelection,
} from './general-settings-state'

export function ClearCacheDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [selection, setSelection] = React.useState<CacheCleanupSelection>(createDefaultCacheCleanupSelection())
  const [clearing, setClearing] = React.useState(false)
  const [result, setResult] = React.useState<ClearCacheResult | null>(null)

  React.useEffect(() => {
    if (!open) {
      return
    }

    setSelection(createDefaultCacheCleanupSelection())
    setResult(null)
    setClearing(false)
  }, [open])

  const handleToggle = (key: CacheCleanupKey, checked: boolean) => {
    setSelection((current) => ({
      ...current,
      [key]: checked,
    }))
  }

  const handleSubmit = async () => {
    if (!hasSelectedCacheCleanup(selection)) {
      return
    }

    setClearing(true)
    setResult(null)

    try {
      const nextResult = await clearCache(selection)
      setResult(nextResult)
      toast.success('缓存清理完成')
    } catch (error) {
      console.error('[ClearCacheDialog] 清理缓存失败:', error)
      toast.error('清理缓存失败')
    } finally {
      setClearing(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => onOpenChange(nextOpen)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>清理缓存</DialogTitle>
          <DialogDescription>
            只会清理安全缓存项，不影响会话、线程、工作区和配置。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-[12px] text-amber-800 dark:text-amber-200">
            将保留所有会话记录、Agent 线程、工作区文件和应用配置，仅删除可安全重建的本地缓存。
          </div>

          <div className="space-y-2">
            {CACHE_CLEANUP_OPTIONS.map((option) => (
              <label
                key={option.key}
                className={cn(
                  'flex items-start gap-3 rounded-xl border px-4 py-3 transition-colors',
                  selection[option.key] ? 'border-primary/20 bg-primary/5' : 'border-border/60 hover:bg-muted/30'
                )}
              >
                <input
                  type="checkbox"
                  checked={selection[option.key]}
                  onChange={(event) => handleToggle(option.key, event.currentTarget.checked)}
                  className="mt-0.5 size-4 rounded border-input accent-primary"
                  disabled={clearing}
                />
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium">{option.label}</div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">{option.desc}</div>
                </div>
              </label>
            ))}
          </div>

          {result && (
            <div className="rounded-xl border bg-muted/30 px-4 py-3 text-[12px]">
              <div className="flex items-center gap-2 font-medium text-foreground">
                <CheckCircle2 size={14} className="text-emerald-500" />
                清理结果
              </div>
              <div className="mt-2 space-y-1 text-muted-foreground">
                <div>已清理：{formatCacheKeys(result.cleared)}</div>
                <div>已跳过：{formatCacheKeys(result.skipped)}</div>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={clearing}>
            取消
          </Button>
          <Button onClick={handleSubmit} disabled={clearing || !hasSelectedCacheCleanup(selection)}>
            {clearing ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
            执行清理
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function formatCacheKeys(keys: CacheCleanupKey[]): string {
  if (keys.length === 0) {
    return '无'
  }

  const labels = new Map(CACHE_CLEANUP_OPTIONS.map((option) => [option.key, option.label]))
  return keys.map((key) => labels.get(key) ?? String(key)).join('、')
}
