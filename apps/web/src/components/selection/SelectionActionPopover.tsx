/**
 * SelectionActionPopover — 划选文本后的浮动动作菜单
 *
 * 复刻自 Proma SelectionActionPopover。出现在选区上方，提供两个动作：
 * 1. 为 Agent 引用 —— 写入 quotedSelectionMapAtom，输入框展示 chip
 * 2. 打开右侧问答 —— 创建新会话并以选区为上下文提问
 *
 * data-selection-action-popover 属性供采集层排除菜单内的 pointer 事件。
 */

import { Bot, MessageCircle } from 'lucide-react'

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
      className="fixed z-[90] flex -translate-x-1/2 -translate-y-full items-center gap-1 rounded-xl border border-[var(--lume-border-subtle)] bg-[var(--lume-bg-elevated)] p-1 shadow-[0_4px_16px_var(--lume-shadow-panel)]"
      style={{ left: x, top: y }}
      onMouseDown={(event) => event.preventDefault()}
    >
      <button
        type="button"
        className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium text-[var(--lume-text-primary)] transition-colors hover:bg-[color:color-mix(in_oklab,var(--brand)_12%,transparent)]"
        onClick={onAddToAgent}
      >
        <Bot className="size-4" />
        为 Agent 引用
      </button>
      {onOpenChat ? (
        <button
          type="button"
          className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium text-[var(--lume-text-primary)] transition-colors hover:bg-[color:color-mix(in_oklab,var(--brand)_12%,transparent)]"
          onClick={() => {
            void onOpenChat()
          }}
        >
          <MessageCircle className="size-4" />
          打开右侧问答
        </button>
      ) : null}
    </div>
  )
}
