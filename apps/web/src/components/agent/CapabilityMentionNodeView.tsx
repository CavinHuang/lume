import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react'
import { BookOpen, Package } from 'lucide-react'
import { useState } from 'react'

export function CapabilityMentionNodeView({ node }: NodeViewProps) {
  const [iconFailed, setIconFailed] = useState(false)
  const label = (node.attrs.label as string | undefined) || (node.attrs.uri as string | undefined) || ''
  const uri = (node.attrs.uri as string | undefined) || ''
  const kind = node.attrs.kind as 'skill' | 'plugin' | 'plugin-skill' | undefined
  const iconUrl = node.attrs.iconUrl as string | undefined
  const isPlugin = kind === 'plugin'

  return (
    <NodeViewWrapper asChild>
      <span
        className="mention capability-mention inline-flex max-w-[260px] items-center gap-1 rounded-md border border-[color:color-mix(in_oklab,var(--lume-accent)_20%,var(--lume-border-subtle))] bg-[var(--lume-accent-soft)] px-1.5 py-0.5 align-baseline text-[13px] font-medium text-[var(--lume-accent)]"
        title={uri}
        data-capability-uri={uri}
      >
        {isPlugin && iconUrl && !iconFailed ? (
          <img
            src={iconUrl}
            alt=""
            className="size-3.5 shrink-0 rounded object-contain"
            onError={() => setIconFailed(true)}
          />
        ) : isPlugin ? (
          <Package size={12} className="shrink-0" />
        ) : (
          <BookOpen size={12} className="shrink-0" />
        )}
        <span className="truncate">{label}</span>
      </span>
    </NodeViewWrapper>
  )
}
