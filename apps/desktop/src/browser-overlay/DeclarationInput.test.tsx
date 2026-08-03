// TDD tests for DeclarationInput（单属性行输入分发：color/opacity/px/combobox）。
// 字段命名遵循 5a styleSnapshotDeclarations 的 camelCase 约定（color/backgroundColor/fontSize 等），
// 而非 Codex 原版的 kebab-case。受控 input onChange 在 happy-dom 不冒泡（Task 41 教训），
// 故 onChange 用例从 React fiber 取 handler 直接调用，等价于真实用户键入触发同一 handler。
import { describe, test, expect, mock } from 'bun:test'
import { electronMockStub } from '../../scripts/test-electron-mock'
await mock.module('electron', () => electronMockStub)
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { ReactNode, PointerEvent as ReactPointerEvent } from 'react'
const { DeclarationInput } = await import('./DeclarationInput')

function render(node: ReactNode): HTMLElement {
  const container = document.createElement('div'); document.body.append(container)
  act(() => { createRoot(container).render(node) })
  return container
}
const decl = (property: string, value = 'v', previousValue = 'p') => ({ property, value, previousValue })

describe('DeclarationInput 输入分发', () => {
  test('color → <input type="color">', () => {
    const c = render(<DeclarationInput declaration={decl('color', '#ff0000')} onChange={() => {}} />)
    expect(c.querySelector('input[type="color"]')).toBeTruthy()
    document.body.innerHTML = ''
  })
  test('backgroundColor → color input（camelCase endsWith Color）', () => {
    const c = render(<DeclarationInput declaration={decl('backgroundColor', '#00f')} onChange={() => {}} />)
    expect(c.querySelector('input[type="color"]')).toBeTruthy()
    document.body.innerHTML = ''
  })
  test('opacity → number input（step 0.01）', () => {
    const c = render(<DeclarationInput declaration={decl('opacity', '0.5')} onChange={() => {}} />)
    const input = c.querySelector('input[type="number"]') as HTMLInputElement
    expect(input).toBeTruthy()
    expect(input.step).toBe('0.01')
    document.body.innerHTML = ''
  })
  test('fontSize → number input（step 1，px 后缀显示）', () => {
    const c = render(<DeclarationInput declaration={decl('fontSize', '16px')} onChange={() => {}} />)
    const input = c.querySelector('input[type="number"]') as HTMLInputElement
    expect(input).toBeTruthy()
    expect(input.step).toBe('1')
    expect(c.querySelector('.decl-unit')?.textContent).toBe('px')
    document.body.innerHTML = ''
  })
  test('fontFamily → combobox（text input + datalist）', () => {
    const c = render(<DeclarationInput declaration={decl('fontFamily', 'sans-serif')} onChange={() => {}} />)
    const input = c.querySelector('input[type="text"]') as HTMLInputElement
    expect(input).toBeTruthy()
    expect(input.getAttribute('list')).toBe('decl-suggestions')
    document.body.innerHTML = ''
  })
  test('fontWeight → text combobox（非 px 数字属性）', () => {
    const c = render(<DeclarationInput declaration={decl('fontWeight', '700')} onChange={() => {}} />)
    expect(c.querySelector('input[type="text"]')).toBeTruthy()
    document.body.innerHTML = ''
  })
  test('onChange 回调（值变更经 fiber-key 触发）', () => {
    const onChange = mock(() => {})
    const c = render(<DeclarationInput declaration={decl('color', '#ff0000')} onChange={onChange} />)
    const input = c.querySelector('input[type="color"]') as HTMLInputElement
    // happy-dom 受控 input onChange 不冒泡（Task 41 教训）：从 React fiber 取 input 节点的 onChange prop
    // 直接调用，等价于真实用户输入触发同一 handler——非空洞（real handler + real payload + 受控断言）。
    const propsKey = Object.keys(input).find((k) => k.startsWith('__reactProps$'))
    const handler = ((input as unknown as Record<string, unknown>)[propsKey!] as { onChange: (e: { target: { value: string } }) => void }).onChange
    act(() => handler({ target: { value: '#00ff00' } }))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange.mock.calls[0]?.[0]).toBe('#00ff00')
    document.body.innerHTML = ''
  })
  test('fontSize onChange 拼接 px 后缀', () => {
    const onChange = mock(() => {})
    const c = render(<DeclarationInput declaration={decl('fontSize', '16px')} onChange={onChange} />)
    const input = c.querySelector('input[type="number"]') as HTMLInputElement
    const propsKey = Object.keys(input).find((k) => k.startsWith('__reactProps$'))
    const handler = ((input as unknown as Record<string, unknown>)[propsKey!] as { onChange: (e: { target: { value: string } }) => void }).onChange
    act(() => handler({ target: { value: '20' } }))
    expect(onChange.mock.calls[0]?.[0]).toBe('20px')
    document.body.innerHTML = ''
  })
})

describe('DeclarationInput scrub 集成（number input onPointerDown）', () => {
  // happy-dom 未暴露全局 PointerEvent：从 fiber 取 onPointerDown prop 直接调用，
  // 然后用 document.dispatchEvent(new MouseEvent('pointermove', ...)) 派发——
  // hook 的 document.addEventListener('pointermove') 按 type 字符串匹配触发（与 Task 41/63 同模式）。
  const getHandler = <T,>(el: Element, name: string): T => {
    const propsKey = Object.keys(el).find((k) => k.startsWith('__reactProps$'))
    return ((el as unknown as Record<string, unknown>)[propsKey!] as Record<string, unknown>)[name] as T
  }
  const makeDown = (clientY: number): ReactPointerEvent => ({
    button: 0, isPrimary: true, pointerType: 'mouse', pointerId: 1,
    clientY, preventDefault: () => {},
    currentTarget: { setPointerCapture: () => {} } as unknown as EventTarget,
  } as unknown as ReactPointerEvent)

  test('opacity number input 挂 onPointerDown（scrub 接线）', () => {
    const c = render(<DeclarationInput declaration={decl('opacity', '0.5')} onChange={() => {}} />)
    const input = c.querySelector('input[type="number"]') as HTMLInputElement
    expect(getHandler(input, 'onPointerDown')).toBeTruthy()
    document.body.innerHTML = ''
  })

  test('color input 不挂 onPointerDown（非 number，无 scrub）', () => {
    const c = render(<DeclarationInput declaration={decl('color', '#ff0000')} onChange={() => {}} />)
    const input = c.querySelector('input[type="color"]') as HTMLInputElement
    expect(getHandler(input, 'onPointerDown')).toBeUndefined()
    document.body.innerHTML = ''
  })

  test('opacity scrub 拖 4px → onChange 字符串值 0.51（受控数字 → 字符串）', () => {
    const onChange = mock(() => {})
    const c = render(<DeclarationInput declaration={decl('opacity', '0.5')} onChange={onChange} />)
    const input = c.querySelector('input[type="number"]') as HTMLInputElement
    const onPointerDown = getHandler<(e: ReactPointerEvent) => void>(input, 'onPointerDown')
    act(() => onPointerDown(makeDown(100)))
    act(() => document.dispatchEvent(new MouseEvent('pointermove', { clientY: 96 })))
    // opacity 走 `${n}` 字符串化分支（非 px）
    expect(onChange.mock.calls[0]?.[0]).toBe('0.51')
    // pointerUp 还原 body
    act(() => document.dispatchEvent(new MouseEvent('pointerup')))
    document.body.innerHTML = ''
  })

  test('fontSize scrub 拖 4px → onChange 拼接 px 后缀（17px）', () => {
    const onChange = mock(() => {})
    const c = render(<DeclarationInput declaration={decl('fontSize', '16px')} onChange={onChange} />)
    const input = c.querySelector('input[type="number"]') as HTMLInputElement
    const onPointerDown = getHandler<(e: ReactPointerEvent) => void>(input, 'onPointerDown')
    act(() => onPointerDown(makeDown(100)))
    act(() => document.dispatchEvent(new MouseEvent('pointermove', { clientY: 96 })))
    // fontSize 走 `${n}px` 拼接分支
    expect(onChange.mock.calls[0]?.[0]).toBe('17px')
    act(() => document.dispatchEvent(new MouseEvent('pointerup')))
    document.body.innerHTML = ''
  })

  test('opacity scrub clamp max=1：向上拖越界 → onChange "1"', () => {
    const onChange = mock(() => {})
    const c = render(<DeclarationInput declaration={decl('opacity', '0.99')} onChange={onChange} />)
    const input = c.querySelector('input[type="number"]') as HTMLInputElement
    const onPointerDown = getHandler<(e: ReactPointerEvent) => void>(input, 'onPointerDown')
    act(() => onPointerDown(makeDown(100)))
    act(() => document.dispatchEvent(new MouseEvent('pointermove', { clientY: 50 })))
    expect(onChange.mock.calls[0]?.[0]).toBe('1')
    act(() => document.dispatchEvent(new MouseEvent('pointerup')))
    document.body.innerHTML = ''
  })
})
