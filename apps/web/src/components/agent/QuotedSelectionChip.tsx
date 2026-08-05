/**
 * QuotedSelectionChip — 输入框上方的划线引用 Chip
 *
 * 展示选中文本摘要 + 来源，hover 显移除按钮。结构与 Proma 一致，
 * 视觉对齐 Lume 设计令牌（--brand / --text-1/3）。
 */

import type { ReactElement, MouseEvent } from 'react'
import { useCallback } from 'react'
import { Quote, X } from 'lucide-react'
import { cn } from '@/lib/utils'

interface QuotedSelectionChipProps {
  /** 选中的文本（截断显示） */
  text: string
  /** 来源文件路径（截断显示，sourceLabel 缺省时用） */
  filePath: string
  /** 来源展示名称 */
  sourceLabel?: string
  /** 移除回调 */
  onRemove: () => void
  className?: string
}

function truncateText(text: string, maxLen = 80): string {
  const singleLine = text.replace(/\s+/g, ' ').trim()
  return singleLine.length > maxLen
    ? singleLine.slice(0, maxLen - 3) + '...'
    : singleLine
}

function truncatePath(filePath: string, maxLen = 40): string {
  if (filePath.length <= maxLen) return filePath
  const name = filePath.split('/').pop() ?? filePath
  return '.../' + name
}

export function QuotedSelectionChip({
  text,
  filePath,
  sourceLabel,
  onRemove,
  className,
}: QuotedSelectionChipProps): ReactElement {
  const handleRemoveClick = useCallback((e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation()
    onRemove()
  }, [onRemove])

  return (
    <div
      className={cn(
        'group/quote relative flex min-w-0 max-w-full items-start gap-2',
        'rounded-lg border border-[color:color-mix(in_oklab,var(--brand)_22%,transparent)]',
        'bg-[color:color-mix(in_oklab,var(--brand)_8%,transparent)]',
        'py-1.5 pl-2.5 pr-7 text-[13px] transition-colors',
        'hover:bg-[color:color-mix(in_oklab,var(--brand)_12%,transparent)]',
        className,
      )}
    >
      <Quote className="mt-0.5 size-4 shrink-0 text-[var(--text-3)]" />
      <div className="flex min-w-0 flex-col">
        <span className="line-clamp-2 break-words leading-snug text-[var(--text-1)] [overflow-wrap:anywhere]">
          {truncateText(text)}
        </span>
        <span className="mt-0.5 break-words text-[11px] text-[var(--text-3)] [overflow-wrap:anywhere]">
          {sourceLabel ?? truncatePath(filePath)}
        </span>
      </div>
      <button
        type="button"
        onClick={handleRemoveClick}
        className={cn(
          'absolute right-1 top-1 flex size-[18px] items-center justify-center rounded-full',
          'text-[var(--text-3)] opacity-0 transition-opacity duration-200',
          'group-hover/quote:opacity-100',
          'hover:bg-[color:color-mix(in_oklab,var(--brand)_18%,transparent)] hover:text-[var(--text-1)]',
        )}
        aria-label="移除引用"
      >
        <X className="size-3" />
      </button>
    </div>
  )
}
