import { useEffect, useRef, useState } from 'react'
import type { OverlayTarget } from './overlayReducer'

export type EditorCardProps = {
  target: OverlayTarget
  initialBody: string
  anchorRect: { x: number; y: number; width: number; height: number }
  canDelete: boolean
  onSubmit: (action: 'add' | 'send', body: string) => void
  onCancel: () => void
  onDelete: () => void
}

// 网页内评论编辑器卡片（对齐 Codex comment 卡片 + 复刻 BrowserAnnotationPopup 交互）。
// 偏移跟随定位（anchorRect 下方），无 transform。Enter=添加，Ctrl/Cmd+Enter=发送，Esc=取消。
export function EditorCard({ target, initialBody, anchorRect, canDelete, onSubmit, onCancel, onDelete }: EditorCardProps) {
  const [body, setBody] = useState(initialBody)
  const inputRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => { inputRef.current?.focus() }, [])
  void target
  const hasBody = body.trim().length > 0
  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') { event.preventDefault(); onCancel(); return }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); if (hasBody) onSubmit('send', body.trim()); return }
    if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey) { event.preventDefault(); if (hasBody) onSubmit('add', body.trim()) }
  }
  return (
    <div className="editor-card" style={{ left: anchorRect.x, top: anchorRect.y + anchorRect.height + 8 }}>
      <input
        ref={inputRef}
        className="editor-input"
        value={body}
        placeholder="添加评论…"
        onChange={(event) => setBody(event.target.value.slice(0, 20_000))}
        onKeyDown={onKeyDown}
      />
      <div className="editor-actions">
        <button type="button" className="editor-btn" disabled={!hasBody} onClick={() => onSubmit('add', body.trim())}>添加</button>
        <button type="button" className="editor-btn" disabled={!hasBody} onClick={() => onSubmit('send', body.trim())}>发送</button>
        {canDelete && <button type="button" className="editor-btn editor-delete" onClick={onDelete}>删除</button>}
      </div>
    </div>
  )
}
