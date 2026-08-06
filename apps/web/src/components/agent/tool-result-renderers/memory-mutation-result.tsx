import { useState } from 'react'
import type { MemoryToolWriteResult } from '@lume/shared'
import { Eye, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { openMemorySource, undoMemoryMutation } from '@/lib/desktop-api'

interface Props { result: unknown }

export function MemoryMutationResult({ result }: Props) {
  const receipt = parseReceipt(result)
  const [undone, setUndone] = useState(false)
  const [busy, setBusy] = useState(false)
  if (!receipt) return null

  const undo = async () => {
    if (!receipt.workspaceSlug) return
    setBusy(true)
    try {
      await undoMemoryMutation({ workspaceSlug: receipt.workspaceSlug, mutationId: receipt.mutationId })
      setUndone(true)
      toast.success('已撤销记忆变更')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '撤销失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-lg border border-border/60 bg-muted/20 p-3 text-sm">
      <div className="font-medium text-foreground">{undone ? '已撤销' : receipt.summary}</div>
      <div className="mt-1 text-xs text-muted-foreground">
        {receipt.scope === 'global' ? '全局' : '当前工作区'}
        {receipt.memoryIds.length > 0 ? ` · ${receipt.memoryIds.length} 条` : ''}
      </div>
      {receipt.evidenceRefs && receipt.evidenceRefs.length > 0 && (
        <div className="mt-1 truncate text-xs text-muted-foreground">
          来源：{receipt.evidenceRefs.map((ref) => ref.path ?? ref.id ?? ref.type).join(' · ')}
        </div>
      )}
      {!undone && (receipt.path || receipt.undoable) && (
        <div className="mt-3 flex gap-2">
          {receipt.path && receipt.workspaceSlug && (
            <Button variant="outline" size="sm" onClick={() => void openMemorySource({ workspaceSlug: receipt.workspaceSlug!, path: receipt.path! })}>
              <Eye size={14} />查看
            </Button>
          )}
          {receipt.undoable && receipt.workspaceSlug && (
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void undo()}>
              <RotateCcw size={14} />撤销
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

function parseReceipt(value: unknown): MemoryToolWriteResult | null {
  let candidate = value
  if (typeof candidate === 'string') {
    try { candidate = JSON.parse(candidate) } catch { return null }
  }
  if (isRecord(candidate) && isRecord(candidate.data)) candidate = candidate.data
  if (!isRecord(candidate) || typeof candidate.mutationId !== 'string' || typeof candidate.summary !== 'string') return null
  return candidate as unknown as MemoryToolWriteResult
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
