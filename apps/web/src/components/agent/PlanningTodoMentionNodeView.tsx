import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react'
import { CheckSquare } from 'lucide-react'

export function PlanningTodoMentionNodeView({ node }: NodeViewProps) {
  const label = typeof node.attrs.displayText === 'string' ? node.attrs.displayText : '待办'
  const todoId = typeof node.attrs.todoId === 'string' ? node.attrs.todoId : ''
  return (
    <NodeViewWrapper asChild>
      <span className="mention inline-flex max-w-[260px] items-center gap-1 rounded-md border border-border/70 bg-muted/40 px-1.5 py-0.5 align-baseline text-[13px] font-medium" data-planning-todo-id={todoId} title={todoId}>
        <CheckSquare size={12} className="shrink-0" />
        <span className="truncate">&amp;{label}</span>
      </span>
    </NodeViewWrapper>
  )
}
