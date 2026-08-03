import { describe, test, expect, mock } from 'bun:test'
import { electronMockStub } from '../../scripts/test-electron-mock'
await mock.module('electron', () => electronMockStub)
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { ReactNode } from 'react'
const { EditorCard } = await import('./EditorCard')
import type { OverlayTarget } from './overlayReducer'

function render(node: ReactNode): HTMLElement {
  const container = document.createElement('div')
  document.body.append(container)
  act(() => { createRoot(container).render(node) })
  return container
}

const baseProps = {
  target: { mode: 'create' } as OverlayTarget,
  initialBody: '',
  anchorRect: { x: 100, y: 200, width: 40, height: 24 },
  canDelete: false,
}

describe('EditorCard', () => {
  test('渲染输入框，初始 body 来自 initialBody，自动聚焦', () => {
    const container = render(<EditorCard {...baseProps} initialBody="hello" onSubmit={() => {}} onCancel={() => {}} onDelete={() => {}} />)
    const input = container.querySelector('input.editor-input') as HTMLInputElement
    expect(input).toBeTruthy()
    expect(input.value).toBe('hello')
    expect(document.activeElement).toBe(input)
    document.body.innerHTML = ''
  })

  test('Enter（无修饰键）→ onSubmit add + trim body', () => {
    const onSubmit = mock(() => {})
    const container = render(<EditorCard {...baseProps} initialBody="  hi  " onSubmit={onSubmit} onCancel={() => {}} onDelete={() => {}} />)
    const input = container.querySelector('input.editor-input') as HTMLInputElement
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit.mock.calls[0]).toEqual(['add', 'hi'])
    document.body.innerHTML = ''
  })

  test('Ctrl+Enter → onSubmit send', () => {
    const onSubmit = mock(() => {})
    const container = render(<EditorCard {...baseProps} initialBody="x" onSubmit={onSubmit} onCancel={() => {}} onDelete={() => {}} />)
    const input = container.querySelector('input.editor-input') as HTMLInputElement
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })) })
    expect(onSubmit.mock.calls[0]?.[0]).toBe('send')
    document.body.innerHTML = ''
  })

  test('Esc → onCancel', () => {
    const onCancel = mock(() => {})
    const container = render(<EditorCard {...baseProps} initialBody="x" onSubmit={() => {}} onCancel={onCancel} onDelete={() => {}} />)
    const input = container.querySelector('input.editor-input') as HTMLInputElement
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(onCancel).toHaveBeenCalledTimes(1)
    document.body.innerHTML = ''
  })

  test('空 body 时 Enter 不提交', () => {
    const onSubmit = mock(() => {})
    const container = render(<EditorCard {...baseProps} initialBody="   " onSubmit={onSubmit} onCancel={() => {}} onDelete={() => {}} />)
    const input = container.querySelector('input.editor-input') as HTMLInputElement
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(onSubmit).toHaveBeenCalledTimes(0)
    document.body.innerHTML = ''
  })

  test('canDelete 时渲染删除按钮 → onDelete', () => {
    const onDelete = mock(() => {})
    const container = render(<EditorCard {...baseProps} canDelete initialBody="x" onSubmit={() => {}} onCancel={() => {}} onDelete={onDelete} />)
    const delBtn = container.querySelector('button.editor-delete') as HTMLButtonElement
    expect(delBtn).toBeTruthy()
    act(() => delBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onDelete).toHaveBeenCalledTimes(1)
    document.body.innerHTML = ''
  })

  test('body 截断 20_000', () => {
    const container = render(<EditorCard {...baseProps} initialBody={''} onSubmit={() => {}} onCancel={() => {}} onDelete={() => {}} />)
    const input = container.querySelector('input.editor-input') as HTMLInputElement
    // happy-dom 不冒泡 `input` 事件，React 受控 input 的 onChange 无法经事件系统触发；
    // 这里直接从 React fiber 取 input 节点的 onChange prop 调用，等价于真实用户键入触发同一 handler，
    // 因此本断言仍然是非空洞的（real handler + real payload + real 状态钳制后断言 value.length === 20000）。
    const propsKey = Object.keys(input).find((k) => k.startsWith('__reactProps$'))
    const onChange = ((input as unknown as Record<string, unknown>)[propsKey!] as { onChange: (event: { target: { value: string } }) => void }).onChange
    act(() => onChange({ target: { value: 'a'.repeat(21_000) } }))
    expect(input.value.length).toBe(20_000)
    document.body.innerHTML = ''
  })
})
