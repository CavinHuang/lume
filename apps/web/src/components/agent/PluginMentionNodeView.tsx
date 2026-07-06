import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react'
import { Puzzle } from 'lucide-react'

/**
 * 插件 mention 的 NodeView：编辑器内渲染带 Puzzle 图标的紫色 chip。
 *
 * node.attrs.label 形如 `%插件名`（含触发符，作为发送 getText 与气泡正则三段统一的 token），
 * 渲染时去掉前导 % 只显示插件名。
 */
export function PluginMentionNodeView({ node }: NodeViewProps) {
  const label = (node.attrs.label as string | undefined) ?? ''
  const name = label.replace(/^%/, '')
  return (
    <NodeViewWrapper asChild>
      <span className="mention plugin-mention inline-flex items-center gap-1 rounded bg-[var(--lume-accent-soft)] px-1 py-0.5 align-baseline font-medium text-[13px] text-[var(--brand)]">
        <Puzzle size={11} className="shrink-0" />
        <span className="truncate">{name}</span>
      </span>
    </NodeViewWrapper>
  )
}
