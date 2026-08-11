import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react'
import { LinkConnectionChip } from '@/components/link/LinkConnectionChip'

export function LinkConnectionMentionNodeView({ node }: NodeViewProps) {
  return (
    <NodeViewWrapper asChild>
      <span className="inline-flex align-baseline" data-link-service={node.attrs.service} data-link-connection={node.attrs.connectionName}>
        <LinkConnectionChip
          service={node.attrs.service as string}
          connectionName={node.attrs.connectionName as string}
          displayText={node.attrs.displayText as string}
        />
      </span>
    </NodeViewWrapper>
  )
}
