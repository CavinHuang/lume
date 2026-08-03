// 编辑器状态机：对齐 Codex comment-preload 的 Ve(prev, msg)。
// 决定「当前活跃编辑器」：评论/设计编辑器开关 + 抗打断（sync/screenshot 透传）。

export type OverlayTarget =
  | { mode: 'create' }
  | { mode: 'edit'; commentId: string }
  | { mode: 'design'; groupId?: string }

export type OverlayEditorState =
  | { type: 'idle' }
  | { type: 'editing'; target: OverlayTarget }

export type OverlayAction =
  | { type: 'select-comment'; commentId: string }
  | { type: 'create-comment-at-point' }
  | { type: 'create-comment-from-selection' }
  | { type: 'open-design-editor-at-point'; groupId?: string }
  | { type: 'restore-editor'; target: OverlayTarget }
  | { type: 'close-editor' }
  | { type: 'sync' }
  | { type: 'prepare-comment-screenshot'; commentId: string }
  | { type: 'clear-comment-screenshot' }

const editingActions = new Set<OverlayAction['type']>([
  'select-comment',
  'create-comment-at-point',
  'create-comment-from-selection',
  'open-design-editor-at-point',
])

function deriveTarget(action: OverlayAction): OverlayTarget {
  switch (action.type) {
    case 'select-comment':
      return { mode: 'edit', commentId: action.commentId }
    case 'open-design-editor-at-point':
      // 携带 groupId（来自 action，5a sync 推送的 activeDesignChange.id）便于后续回溯
      return { mode: 'design', ...(action.groupId ? { groupId: action.groupId } : {}) }
    default:
      return { mode: 'create' }
  }
}

export function overlayReducer(prev: OverlayEditorState, action: OverlayAction): OverlayEditorState {
  if (editingActions.has(action.type)) {
    return { type: 'editing', target: deriveTarget(action) }
  }
  switch (action.type) {
    case 'restore-editor':
      // 已在编辑态则保持（抗打断），否则进入新编辑态
      return prev.type === 'editing' ? prev : { type: 'editing', target: action.target }
    case 'close-editor':
      return { type: 'idle' }
    case 'sync':
    case 'prepare-comment-screenshot':
    case 'clear-comment-screenshot':
      return prev
  }
}
