import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

export interface ConfirmDialogOptions {
  title: string
  description: string
  confirmLabel?: string
  destructive?: boolean
  secondaryLabel?: string
}

interface ConfirmDialogProps extends ConfirmDialogOptions {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
  onSecondary?: () => void
  /** 进行中置真：禁用全部按钮并在确认键上显示 spinner，阻止重复提交与误关。 */
  loading?: boolean
  loadingLabel?: string
}

export function ConfirmDialog({
  title,
  description,
  confirmLabel = '确认',
  destructive = false,
  secondaryLabel,
  open,
  onOpenChange,
  onConfirm,
  onSecondary,
  loading = false,
  loadingLabel,
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!loading) onOpenChange(next) }}>
      <DialogContent className="sm:max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" disabled={loading} onClick={() => onOpenChange(false)}>
            取消
          </Button>
          {secondaryLabel && onSecondary && (
            <Button variant="outline" disabled={loading} onClick={onSecondary}>
              {secondaryLabel}
            </Button>
          )}
          <Button
            variant={destructive ? 'destructive' : 'default'}
            disabled={loading}
            onClick={() => {
              onConfirm()
              // loading 语义下由父层在异步完成后关窗，让 spinner 真正可见。
              if (!loading) onOpenChange(false)
            }}
          >
            {loading && <Loader2 className="size-3.5 animate-spin" />}
            {loading && loadingLabel ? loadingLabel : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
