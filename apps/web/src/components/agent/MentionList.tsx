/**
 * MentionSuggestion - AgentInput 的 mention 下拉建议列表
 *
 * 支持三种 mention 触发：
 * - @ → 文件 mention（从当前线程工作目录列出文件）
 * - / → Skill mention（命令提示）
 * - # → MCP 工具 mention
 */

import { forwardRef, useEffect, useImperativeHandle, useState, useCallback } from 'react'
import { cn } from '@/lib/utils'
import { File, Slash, Hash } from 'lucide-react'

export interface MentionItem {
  id: string
  label: string
  type: 'file' | 'skill' | 'mcp'
}

interface MentionListProps {
  items: MentionItem[]
  command: (item: { id: string; label: string }) => void
}

export interface MentionListRef {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean
}

export const MentionList = forwardRef<MentionListRef, MentionListProps>(
  function MentionList({ items, command }, ref) {
    const [selectedIndex, setSelectedIndex] = useState(0)

    useEffect(() => setSelectedIndex(0), [items])

    const selectItem = useCallback((index: number) => {
      const item = items[index]
      if (item) command({ id: item.id, label: item.label })
    }, [items, command])

    useImperativeHandle(ref, () => ({
      onKeyDown: ({ event }: { event: KeyboardEvent }) => {
        if (event.key === 'ArrowUp') {
          setSelectedIndex((i) => (i + items.length - 1) % items.length)
          return true
        }
        if (event.key === 'ArrowDown') {
          setSelectedIndex((i) => (i + 1) % items.length)
          return true
        }
        if (event.key === 'Enter') {
          selectItem(selectedIndex)
          return true
        }
        return false
      },
    }))

    if (items.length === 0) {
      return (
        <div className="rounded-lg border border-border/60 bg-popover shadow-lg p-2 text-[12px] text-muted-foreground">
          无匹配结果
        </div>
      )
    }

    const iconMap = {
      file: <File size={13} className="text-blue-500" />,
      skill: <Slash size={13} className="text-orange-500" />,
      mcp: <Hash size={13} className="text-purple-500" />,
    }

    return (
      <div className="rounded-lg border border-border/60 bg-popover shadow-lg py-1 max-h-[200px] overflow-y-auto min-w-[200px]">
        {items.map((item, index) => (
          <button
            key={item.id}
            className={cn(
              'w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-left transition-colors',
              index === selectedIndex
                ? 'bg-accent text-accent-foreground'
                : 'text-foreground/70 hover:bg-muted/50'
            )}
            onClick={() => selectItem(index)}
          >
            {iconMap[item.type]}
            <span className="truncate">{item.label}</span>
          </button>
        ))}
      </div>
    )
  }
)
