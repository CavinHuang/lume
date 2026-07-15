import * as React from 'react'
import { FolderOpen, FolderPlus, Loader2 } from 'lucide-react'
import type { AgentWorkspace } from '@lume/shared'
import { toast } from 'sonner'
import { openFolderDialog, sidecarCall } from '@/lib/desktop-api'
import { Button } from '@/components/ui/button'
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
  const [projectPath, setProjectPath] = React.useState('')
  const [creating, setCreating] = React.useState(false)

  React.useEffect(() => {
    if (!open) {
      setProjectPath('')
      setCreating(false)
    }
  }, [open])

  const handlePickFolder = async () => {
    try {
      const selection = await openFolderDialog()
      if (selection.path) {
        setProjectPath(selection.path)
      }
    } catch (error) {
      console.error('[CreateWorkspaceDialog] 选择项目目录失败:', error)
      toast.error('选择项目目录失败')
    }
  }

  const handleSubmit = async () => {
    if (creating) return

    setCreating(true)
    try {
      const workspace = await createWorkspaceFromDraft(
        projectPath,
        (input) => sidecarCall<AgentWorkspace>('agent:create-workspace', input),
      )

      if (!workspace) {
        setCreating(false)
        return
      }

      await onCreated?.(workspace)
      toast.success(`已添加项目「${workspace.name}」`)
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
          <DialogTitle>添加项目</DialogTitle>
          <DialogDescription>
            选择一个本地项目目录。Agent 会在该目录中运行，Lume 管理的临时文件会保存在独立工作目录中。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="rounded-xl border border-border/60 bg-muted/20 px-4 py-3 text-[12px] text-muted-foreground">
            Lume 只记录项目目录路径，不会复制、初始化或删除你的真实项目文件夹。
          </div>

          <div className="space-y-2">
            <label htmlFor="create-workspace-path" className="text-[12px] font-medium text-foreground/80">
              项目目录
            </label>
            <Button
              id="create-workspace-path"
              type="button"
              variant="outline"
              className="w-full justify-start gap-2"
              onClick={() => void handlePickFolder()}
              disabled={creating}
              autoFocus
            >
              <FolderOpen size={14} />
              <span className="truncate">{projectPath || '选择项目文件夹'}</span>
            </Button>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={creating}>
            取消
          </Button>
          <Button onClick={() => void handleSubmit()} disabled={creating || projectPath.trim().length === 0}>
            {creating ? <Loader2 size={14} className="animate-spin" /> : <FolderPlus size={14} />}
            添加项目
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
