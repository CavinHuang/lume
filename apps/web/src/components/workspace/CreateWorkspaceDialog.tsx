import * as React from 'react'
import { FolderPlus, Loader2 } from 'lucide-react'
import type { AgentWorkspace } from '@lume/shared'
import { toast } from 'sonner'
import { sidecarCall } from '@/lib/desktop-api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { createWorkspaceFromDraft } from './create-workspace-dialog-state'

export function CreateWorkspaceDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated?: (workspace: AgentWorkspace) => void | Promise<void>
}) {
  const [draftName, setDraftName] = React.useState('')
  const [creating, setCreating] = React.useState(false)

  React.useEffect(() => {
    if (!open) {
      setDraftName('')
      setCreating(false)
    }
  }, [open])

  const handleSubmit = async () => {
    if (creating) return

    setCreating(true)
    try {
      const workspace = await createWorkspaceFromDraft(
        draftName,
        (input) => sidecarCall<AgentWorkspace>('agent:create-workspace', input),
      )

      if (!workspace) {
        setCreating(false)
        return
      }

      await onCreated?.(workspace)
      toast.success(`已创建工作区「${workspace.name}」`)
      onOpenChange(false)
    } catch (error) {
      console.error('[CreateWorkspaceDialog] 创建工作区失败:', error)
      toast.error('创建失败')
    } finally {
      setCreating(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>创建工作区</DialogTitle>
          <DialogDescription>
            工作区会集中保存线程、共享文件和对应配置，方便把不同任务分开管理。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="rounded-xl border border-border/60 bg-muted/20 px-4 py-3 text-[12px] text-muted-foreground">
            推荐使用简短、容易辨认的名称，例如“API 集成”、“设计稿”或“客户支持”。
          </div>

          <div className="space-y-2">
            <label htmlFor="create-workspace-name" className="text-[12px] font-medium text-foreground/80">
              工作区名称
            </label>
            <Input
              id="create-workspace-name"
              value={draftName}
              onChange={(event) => setDraftName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void handleSubmit()
                }
              }}
              placeholder="例如：产品规划"
              maxLength={50}
              disabled={creating}
              autoFocus
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={creating}>
            取消
          </Button>
          <Button onClick={() => void handleSubmit()} disabled={creating || draftName.trim().length === 0}>
            {creating ? <Loader2 size={14} className="animate-spin" /> : <FolderPlus size={14} />}
            创建工作区
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
