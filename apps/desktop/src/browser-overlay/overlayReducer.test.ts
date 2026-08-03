import { test, expect } from 'bun:test'
import { overlayReducer, type OverlayEditorState } from './overlayReducer'

const idle: OverlayEditorState = { type: 'idle' }

test('create-comment-at-point 进入编辑态', () => {
  const next = overlayReducer(idle, { type: 'create-comment-at-point' })
  expect(next).toEqual({ type: 'editing', target: { mode: 'create' } })
})

test('select-comment 进入 edit 态并带 commentId', () => {
  const next = overlayReducer(idle, { type: 'select-comment', commentId: 'c1' })
  expect(next).toEqual({ type: 'editing', target: { mode: 'edit', commentId: 'c1' } })
})

test('open-design-editor-at-point 进入 design 态', () => {
  const next = overlayReducer(idle, { type: 'open-design-editor-at-point' })
  expect(next).toEqual({ type: 'editing', target: { mode: 'design' } })
})

test('restore-editor 在已编辑时保持当前态', () => {
  const editing: OverlayEditorState = { type: 'editing', target: { mode: 'edit', commentId: 'c1' } }
  const next = overlayReducer(editing, { type: 'restore-editor', target: { mode: 'create' } })
  expect(next).toBe(editing)
})

test('restore-editor 在 idle 时进入新编辑态', () => {
  const next = overlayReducer(idle, { type: 'restore-editor', target: { mode: 'create' } })
  expect(next).toEqual({ type: 'editing', target: { mode: 'create' } })
})

test('close-editor 回到 idle', () => {
  const editing: OverlayEditorState = { type: 'editing', target: { mode: 'create' } }
  expect(overlayReducer(editing, { type: 'close-editor' })).toEqual({ type: 'idle' })
})

test('sync / prepare-comment-screenshot / clear-comment-screenshot 透传不打断编辑', () => {
  const editing: OverlayEditorState = { type: 'editing', target: { mode: 'create' } }
  expect(overlayReducer(editing, { type: 'sync' })).toBe(editing)
  expect(overlayReducer(editing, { type: 'prepare-comment-screenshot', commentId: 'c1' })).toBe(editing)
  expect(overlayReducer(editing, { type: 'clear-comment-screenshot' })).toBe(editing)
})
