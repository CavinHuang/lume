/**
 * SelectionActionPopover — 划选文本后的浮动动作菜单
 *
 * 出现在选区上方，提供两个动作：
 * 1. 为 Agent 引用 —— 写入 quotedSelectionMapAtom，输入框展示 chip
 * 2. 打开右侧问答 —— 新建会话并以选区为上下文提问
 *
 * data-selection-action-popover 属性供采集层排除菜单内的 pointer 事件。
 * 按钮走共享 Button（ghost），不手写样式（AGENTS.md UI 规范）。
 */

import { Bot, MessageCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface SelectionActionPopoverProps {
  x: number
  y: number
  onAddToAgent: () => void
  /** 可选第二动作（跨会话问答）。Lume 无 Proma 的右侧 side chat，需上层提供导航实现；缺省则只显示「为 Agent 引用」 */
  onOpenChat?: () => void | Promise<void>
}

export function SelectionActionPopover({
  x,
  y,
  onAddToAgent,
  onOpenChat,
}: SelectionActionPopoverProps): React.JSX.Element {
  return (
    <div
      data-selection-action-popover
      className="fixed z-[90] -translate-x-1/2 -translate-y-full"
      style={{ left: x, top: y }}
      onMouseDown={(event) => event.preventDefault()}
    >
      <div className="animate-in fade-in zoom-in-95 slide-in-from-bottom-1 flex origin-bottom items-center gap-1 rounded-xl border border-[var(--lume-border-subtle)] bg-[var(--lume-bg-elevated)] p-1 shadow-[0_4px_16px_var(--lume-shadow-panel)] duration-150 motion-reduce:animate-none">
        <Button variant="ghost" size="default" onClick={onAddToAgent} className="transition-transform duration-150 active:scale-[0.97] motion-reduce:transition-none">
          <Bot />
          为 Agent 引用
        </Button>
        {onOpenChat ? (
          <Button
            variant="ghost"
            size="default"
            className="transition-transform duration-150 active:scale-[0.97] motion-reduce:transition-none"
            onClick={() => {
              void onOpenChat()
            }}
          >
            <MessageCircle />
            打开右侧问答
          </Button>
        ) : null}
      </div>
    </div>
  )
}
