import { useEffect, useReducer, useRef, useState } from 'react'
import { Marker } from './Marker'
import { PreviewCard } from './PreviewCard'
import { EditorCard } from './EditorCard'
import { overlayReducer, type OverlayEditorState, type OverlayTarget } from './overlayReducer'
import type { GuestBridge, GuestState } from './guest-state'
import { useAnnotationInteraction } from './useAnnotationInteraction'
import { SelectionHighlight } from './SelectionHighlight'
import { CursorBadge } from './CursorBadge'

// 从 activeDraft.anchor.rect 推导 EditorCard 定位 rect；缺失时回退到 anchor.markerPoint 或默认 8,8。
function editorRect(draft: unknown): { x: number; y: number; width: number; height: number } {
  const anchor = (draft as { anchor?: { rect?: { x?: number; y?: number; width?: number; height?: number }; markerPoint?: { x?: number; y?: number } } }).anchor
  const rect = anchor?.rect
  if (rect && typeof rect.x === 'number' && typeof rect.y === 'number') return { x: rect.x, y: rect.y, width: rect.width ?? 1, height: rect.height ?? 1 }
  const point = anchor?.markerPoint
  return { x: point?.x ?? 8, y: point?.y ?? 8, width: 1, height: 1 }
}

// 接 bridge 同步 guest state，渲染 Marker 列表 + 交互层（hover/cursor/preview）。
export function AnnotationOverlay({ bridge, host }: { bridge: GuestBridge; host: HTMLElement | null }) {
  const [state, setState] = useState<GuestState | null>(() => bridge.getState())
  const [editor, dispatch] = useReducer(overlayReducer, { type: 'idle' } as OverlayEditorState)
  useEffect(() => bridge.subscribe(setState), [bridge])
  // activeDraft → restore-editor（target 从 activeDraft.id 推导 edit/create）；消失 → close-editor
  useEffect(() => {
    const draft = state?.activeDraft as { id?: string; anchor?: { rect?: { x: number; y: number; width: number; height: number } } } | undefined
    if (draft) {
      const target: OverlayTarget = draft.id ? { mode: 'edit', commentId: draft.id } : { mode: 'create' }
      dispatch({ type: 'restore-editor', target })
    } else {
      dispatch({ type: 'close-editor' })
    }
  }, [state?.activeDraft])
  const interaction = useAnnotationInteraction({
    bridge,
    mode: state?.mode ?? 'browse',
    purpose: state?.purpose ?? 'annotation',
    host,
    generation: state?.generation ?? 0,
    win: window,
  })
  const comments = state?.comments ?? []
  return (
    <>
      <div className="markers-layer">
        {comments.map((comment, index) => (
          <Marker
            key={`${String(comment.id ?? index)}-${interaction.refreshKey}`}
            comment={comment}
            index={index}
            win={window}
            onHoverEnter={interaction.marker.enter}
            onHoverLeave={interaction.marker.leave}
            onClickAnchor={interaction.marker.click}
          />
        ))}
      </div>
      <div className="interaction-layer">
        {interaction.hoverRect && <SelectionHighlight rect={interaction.hoverRect} />}
        {interaction.cursorPos && <CursorBadge pos={interaction.cursorPos} />}
        {interaction.preview && <PreviewCard data={interaction.preview} />}
        {editor.type === 'editing' && state?.activeDraft ? (
          <EditorCard
            target={editor.target}
            initialBody={String((state.activeDraft as { body?: unknown }).body ?? '')}
            anchorRect={editorRect(state.activeDraft)}
            canDelete={editor.target.mode === 'edit'}
            onSubmit={(action, body) => bridge.send({ type: 'editor-submit', action, body })}
            onCancel={() => bridge.send({ type: 'editor-cancel' })}
            onDelete={() => bridge.send({ type: 'editor-delete' })}
          />
        ) : null}
      </div>
    </>
  )
}
