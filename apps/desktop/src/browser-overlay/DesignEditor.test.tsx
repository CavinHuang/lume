// TDD tests for DesignEditor（主组件：sectionGroup 渲染 + DeclarationInput + hold-to-view + 提交）。
// 字段命名遵循 5a styleSnapshotDeclarations 的 camelCase 约定（color/fontSize/marginTop/gap 等）。
// happy-dom 受控 input onChange 不冒泡（Task 41 教训），故 onChange 用例从 React fiber 取 handler
// 直接调用，等价于真实用户键入触发同一 handler——非空洞（real handler + real payload + 受控断言）。
// hold-to-view：键盘通道用 dispatchEvent（KeyboardEvent 在 happy-dom 经 React 合成系统派发）；
// 指针通道用 fiber-key（happy-dom 未暴露全局 PointerEvent——直接取 onPointerDown/Up/Cancel prop
// 调用，等价于真实按下/松开触发同一 handler，非空洞）。
import { describe, test, expect, mock } from 'bun:test'
import { electronMockStub } from '../../scripts/test-electron-mock'
await mock.module('electron', () => electronMockStub)
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { ReactNode } from 'react'
const { DesignEditor } = await import('./DesignEditor')
import type { ActiveDesignChange } from './DesignEditor'
import type { AgentBrowserAnchor, AgentBrowserDesignDeclaration } from '../../../../packages/shared/src/types/agent'

function render(node: ReactNode): HTMLElement {
  const container = document.createElement('div'); document.body.append(container)
  act(() => { createRoot(container).render(node) })
  return container
}

const anchor: AgentBrowserAnchor = {
  kind: 'element',
  url: 'https://example.com',
  generation: 1,
  framePath: [],
  rect: { x: 0, y: 0, width: 10, height: 10 },
}

const decl = (property: string, value = 'v', previousValue = 'p'): AgentBrowserDesignDeclaration => ({ property, value, previousValue })

const baseChange = (declarations: AgentBrowserDesignDeclaration[]): ActiveDesignChange => ({ id: 'dc1', anchor, declarations })

// 从 DOM 节点取 React fiber 上的 props（happy-dom 受控 input onChange 不冒泡）。
function getHandler<T = (event: { target: { value: string } }) => void>(el: Element, name: string): T {
  const propsKey = Object.keys(el).find((k) => k.startsWith('__reactProps$'))
  return ((el as unknown as Record<string, unknown>)[propsKey!] as Record<string, unknown>)[name] as T
}

describe('DesignEditor 主组件', () => {
  test('渲染 dimensions/spacing/flex-spacing/declaration 四类 section', () => {
    const declarations = [
      decl('width', '100px', '80px'),
      decl('height', '50px', '40px'),
      decl('marginTop', '10px', '5px'),
      decl('gap', '8px', '4px'),
      decl('color', 'red', 'blue'),
    ]
    const c = render(<DesignEditor activeDesignChange={baseChange(declarations)} onUpdate={() => {}} onDelete={() => {}} onToggleOriginalView={() => {}} />)
    // 四个 section：dimensions / spacing / flex-spacing / declaration
    expect(c.querySelectorAll('.design-section').length).toBe(4)
    // 标题 + section 标签
    expect(c.querySelector('.design-editor-title')?.textContent).toBe('设计')
    // dimensions：宽 + 高 label
    expect(c.textContent ?? '').toContain('宽')
    expect(c.textContent ?? '').toContain('高')
    // spacing：margin → 外边距
    expect(c.textContent ?? '').toContain('外边距')
    // flex-spacing：间距 label
    expect(c.textContent ?? '').toContain('间距')
    document.body.innerHTML = ''
  })

  test('shorthand（margin/padding 单字段）落 declaration section，不展开为 longhand', () => {
    // 5a styleSnapshotDeclarations 捕获 shorthand（margin/padding）→ 不匹配 spacing longhand 正则 → declaration section
    const declarations = [decl('margin', '10px', '5px')]
    const c = render(<DesignEditor activeDesignChange={baseChange(declarations)} onUpdate={() => {}} onDelete={() => {}} onToggleOriginalView={() => {}} />)
    expect(c.querySelectorAll('.design-section').length).toBe(1)
    // 仅一个 section，且是 declaration（不含 外边距 label）
    expect(c.textContent ?? '').not.toContain('外边距')
    // 渲染 margin 单行（DeclarationInput 文本输入）
    expect(c.querySelector('input[type="text"]')).toBeTruthy()
    document.body.innerHTML = ''
  })

  test('编辑 color declaration → 提交 onUpdate 含更新值（受控 setState 流转）', () => {
    const onUpdate = mock(() => {})
    const declarations = [decl('color', 'red', 'blue'), decl('fontSize', '16px', '14px')]
    const c = render(<DesignEditor activeDesignChange={baseChange(declarations)} onUpdate={onUpdate} onDelete={() => {}} onToggleOriginalView={() => {}} />)
    // 编辑 color：触发 DeclarationInput 内 color input 的 onChange（fiber-key 取 handler）
    const colorInput = c.querySelector('input[type="color"]') as HTMLInputElement
    const onChange = getHandler(colorInput, 'onChange')
    act(() => onChange({ target: { value: '#00ff00' } }))
    // 提交
    const submitBtn = c.querySelector('button.design-editor-submit') as HTMLButtonElement
    act(() => submitBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onUpdate).toHaveBeenCalledTimes(1)
    const arg = onUpdate.mock.calls[0]?.[0] as ActiveDesignChange
    expect(arg.id).toBe('dc1')
    expect(arg.anchor).toBe(anchor)
    // 推送全部 declarations（5a 存全部，非 Codex diff）：color 更新，fontSize 保持
    expect(arg.declarations.length).toBe(2)
    expect(arg.declarations[0]).toEqual({ property: 'color', value: '#00ff00', previousValue: 'blue' })
    expect(arg.declarations[1]).toEqual({ property: 'fontSize', value: '16px', previousValue: '14px' })
    // 空 comment → undefined
    expect(arg.comment).toBeUndefined()
    document.body.innerHTML = ''
  })

  test('提交按钮 → onUpdate（保留 id/anchor/text，未编辑时 declarations 原样回传）', () => {
    const onUpdate = mock(() => {})
    const declarations = [decl('color', 'red', 'blue')]
    const change: ActiveDesignChange = { id: 'dc7', anchor, declarations, text: { previousValue: 'old', value: 'new' } }
    const c = render(<DesignEditor activeDesignChange={change} onUpdate={onUpdate} onDelete={() => {}} onToggleOriginalView={() => {}} />)
    const submitBtn = c.querySelector('button.design-editor-submit') as HTMLButtonElement
    act(() => submitBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    const arg = onUpdate.mock.calls[0]?.[0] as ActiveDesignChange
    expect(arg.id).toBe('dc7')
    expect(arg.text).toEqual({ previousValue: 'old', value: 'new' })
    expect(arg.declarations).toEqual(declarations)
    document.body.innerHTML = ''
  })

  test('comment 输入随提交 onUpdate 回传（非空）', () => {
    const onUpdate = mock(() => {})
    const c = render(<DesignEditor activeDesignChange={baseChange([decl('color')])} onUpdate={onUpdate} onDelete={() => {}} onToggleOriginalView={() => {}} />)
    const commentInput = c.querySelector('input.design-editor-comment') as HTMLInputElement
    const onChange = getHandler(commentInput, 'onChange')
    act(() => onChange({ target: { value: '调一下颜色' } }))
    const submitBtn = c.querySelector('button.design-editor-submit') as HTMLButtonElement
    act(() => submitBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    const arg = onUpdate.mock.calls[0]?.[0] as ActiveDesignChange
    expect(arg.comment).toBe('调一下颜色')
    document.body.innerHTML = ''
  })

  test('comment 截断 20_000 字符', () => {
    const c = render(<DesignEditor activeDesignChange={baseChange([decl('color')])} onUpdate={() => {}} onDelete={() => {}} onToggleOriginalView={() => {}} />)
    const commentInput = c.querySelector('input.design-editor-comment') as HTMLInputElement
    const onChange = getHandler(commentInput, 'onChange')
    act(() => onChange({ target: { value: 'a'.repeat(21_000) } }))
    expect(commentInput.value.length).toBe(20_000)
    document.body.innerHTML = ''
  })

  test('hold-to-view pointerdown → onToggleOriginalView(true)，pointerup → false', () => {
    const onToggle = mock(() => {})
    const c = render(<DesignEditor activeDesignChange={baseChange([decl('color')])} onUpdate={() => {}} onDelete={() => {}} onToggleOriginalView={onToggle} />)
    const holdBtn = c.querySelector('button.design-editor-hold') as HTMLButtonElement
    // happy-dom 未暴露全局 PointerEvent：从 fiber 取 onPointerDown/Up prop 直接调用（handler 忽略事件对象）
    const onPointerDown = getHandler<() => void>(holdBtn, 'onPointerDown')
    const onPointerUp = getHandler<() => void>(holdBtn, 'onPointerUp')
    act(() => onPointerDown())
    expect(onToggle.mock.calls[0]?.[0]).toBe(true)
    act(() => onPointerUp())
    expect(onToggle.mock.calls[1]?.[0]).toBe(false)
    document.body.innerHTML = ''
  })

  test('hold-to-view pointercancel → onToggleOriginalView(false)', () => {
    const onToggle = mock(() => {})
    const c = render(<DesignEditor activeDesignChange={baseChange([decl('color')])} onUpdate={() => {}} onDelete={() => {}} onToggleOriginalView={onToggle} />)
    const holdBtn = c.querySelector('button.design-editor-hold') as HTMLButtonElement
    const onPointerCancel = getHandler<() => void>(holdBtn, 'onPointerCancel')
    act(() => onPointerCancel())
    expect(onToggle.mock.calls[0]?.[0]).toBe(false)
    document.body.innerHTML = ''
  })

  test('hold-to-view Space keydown → true，keyup → false', () => {
    const onToggle = mock(() => {})
    const c = render(<DesignEditor activeDesignChange={baseChange([decl('color')])} onUpdate={() => {}} onDelete={() => {}} onToggleOriginalView={onToggle} />)
    const holdBtn = c.querySelector('button.design-editor-hold') as HTMLButtonElement
    act(() => holdBtn.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })))
    expect(onToggle.mock.calls[0]?.[0]).toBe(true)
    act(() => holdBtn.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', bubbles: true })))
    expect(onToggle.mock.calls[1]?.[0]).toBe(false)
    document.body.innerHTML = ''
  })

  test('hold-to-view Enter keydown → true（键盘通道）', () => {
    const onToggle = mock(() => {})
    const c = render(<DesignEditor activeDesignChange={baseChange([decl('color')])} onUpdate={() => {}} onDelete={() => {}} onToggleOriginalView={onToggle} />)
    const holdBtn = c.querySelector('button.design-editor-hold') as HTMLButtonElement
    act(() => holdBtn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(onToggle.mock.calls[0]?.[0]).toBe(true)
    document.body.innerHTML = ''
  })

  test('hold-to-view keydown repeat=true → no-op（!e.repeat 守卫）', () => {
    const onToggle = mock(() => {})
    const c = render(<DesignEditor activeDesignChange={baseChange([decl('color')])} onUpdate={() => {}} onDelete={() => {}} onToggleOriginalView={onToggle} />)
    const holdBtn = c.querySelector('button.design-editor-hold') as HTMLButtonElement
    act(() => holdBtn.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', repeat: true, bubbles: true })))
    expect(onToggle).not.toHaveBeenCalled()
    document.body.innerHTML = ''
  })

  test('hold-to-view 其他键（如 Tab）→ no-op', () => {
    const onToggle = mock(() => {})
    const c = render(<DesignEditor activeDesignChange={baseChange([decl('color')])} onUpdate={() => {}} onDelete={() => {}} onToggleOriginalView={onToggle} />)
    const holdBtn = c.querySelector('button.design-editor-hold') as HTMLButtonElement
    act(() => holdBtn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })))
    expect(onToggle).not.toHaveBeenCalled()
    document.body.innerHTML = ''
  })

  test('删除按钮 → onDelete', () => {
    const onDelete = mock(() => {})
    const c = render(<DesignEditor activeDesignChange={baseChange([decl('color')])} onUpdate={() => {}} onDelete={onDelete} onToggleOriginalView={() => {}} />)
    const delBtn = c.querySelector('button.design-editor-delete') as HTMLButtonElement
    act(() => delBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onDelete).toHaveBeenCalledTimes(1)
    document.body.innerHTML = ''
  })

  test('空 declarations → 仅渲染 header/comment/submit，body 无 section', () => {
    const c = render(<DesignEditor activeDesignChange={baseChange([])} onUpdate={() => {}} onDelete={() => {}} onToggleOriginalView={() => {}} />)
    expect(c.querySelectorAll('.design-section').length).toBe(0)
    expect(c.querySelector('.design-editor-submit')).toBeTruthy()
    expect(c.querySelector('input.design-editor-comment')).toBeTruthy()
    document.body.innerHTML = ''
  })
})

// Task 74：Alt 多选（Codex §1.3）——DesignEditor 渲染 activeDesignChange.additionalAnchors
// 列表（annotationSelectionAnchors）+ onRemoveSelection 回调（→ bridge.send remove-annotation-selection）。
// host 是 additionalAnchors 单一来源；DesignEditor 仅渲染 + 移除。
describe('DesignEditor annotationSelectionAnchors 渲染', () => {
  const anchor2: AgentBrowserAnchor = { kind: 'element', url: 'https://example.com', generation: 1, framePath: [], selector: '#a2', rect: { x: 50, y: 60, width: 30, height: 40 } }
  const anchor3: AgentBrowserAnchor = { kind: 'element', url: 'https://example.com', generation: 1, framePath: [], selector: '#a3', rect: { x: 70, y: 80, width: 30, height: 40 } }

  test('activeDesignChange.additionalAnchors 渲染列表（每条一个 selection row）', () => {
    const c = render(
      <DesignEditor
        activeDesignChange={{ id: 'dc1', anchor, declarations: [decl('color')], additionalAnchors: [anchor2, anchor3] }}
        onUpdate={() => {}} onDelete={() => {}} onToggleOriginalView={() => {}} onRemoveSelection={() => {}}
      />,
    )
    // 两条 selection
    const rows = c.querySelectorAll('[data-selection-index]')
    expect(rows.length).toBe(2)
    expect((rows[0] as HTMLElement).getAttribute('data-selection-index')).toBe('0')
    expect((rows[1] as HTMLElement).getAttribute('data-selection-index')).toBe('1')
    document.body.innerHTML = ''
  })

  test('无 additionalAnchors：不渲染 selection 列表', () => {
    const c = render(
      <DesignEditor
        activeDesignChange={baseChange([decl('color')])}
        onUpdate={() => {}} onDelete={() => {}} onToggleOriginalView={() => {}} onRemoveSelection={() => {}}
      />,
    )
    expect(c.querySelectorAll('[data-selection-index]').length).toBe(0)
    document.body.innerHTML = ''
  })

  test('点击 remove 按钮 → onRemoveSelection 收到对应 selectionIndex', () => {
    const onRemoveSelection = mock(() => {})
    const c = render(
      <DesignEditor
        activeDesignChange={{ id: 'dc1', anchor, declarations: [decl('color')], additionalAnchors: [anchor2, anchor3] }}
        onUpdate={() => {}} onDelete={() => {}} onToggleOriginalView={() => {}} onRemoveSelection={onRemoveSelection}
      />,
    )
    const removeBtns = c.querySelectorAll('button.design-selection-remove')
    expect(removeBtns.length).toBe(2)
    act(() => (removeBtns[1] as HTMLButtonElement).dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onRemoveSelection).toHaveBeenCalledTimes(1)
    expect(onRemoveSelection.mock.calls[0]?.[0]).toBe(1)
    document.body.innerHTML = ''
  })

  test('提交时 onUpdate 不携带 additionalAnchors（避免 host 误判为追加）', () => {
    const onUpdate = mock(() => {})
    const c = render(
      <DesignEditor
        activeDesignChange={{ id: 'dc1', anchor, declarations: [decl('color')], additionalAnchors: [anchor2] }}
        onUpdate={onUpdate} onDelete={() => {}} onToggleOriginalView={() => {}} onRemoveSelection={() => {}}
      />,
    )
    const submitBtn = c.querySelector('button.design-editor-submit') as HTMLButtonElement
    act(() => submitBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    const arg = onUpdate.mock.calls[0]?.[0] as ActiveDesignChange
    // 关键：additionalAnchors 不在 group 中（host 看到该字段缺失 → 保留现有，不追加）
    expect(arg.additionalAnchors).toBeUndefined()
    // 其它字段保留
    expect(arg.id).toBe('dc1')
    expect(arg.declarations).toEqual([decl('color')])
    document.body.innerHTML = ''
  })
})

// locked relationships（Codex bWo 实证）：dimensions 比例锁 width:height + spacing 对边锁 top⇄bottom/left⇄right。
// 锁联动 bWo：changeValue 扩展为单次 setDeclarations 批量更新两 declaration。
// happy-dom 受控 onChange 不冒泡 → fiber-key 取 handler；scrub pointerdown 同理（useScrub onPointerDown）。
describe('DesignEditor locked relationships', () => {
  test('dimensions 比例锁：锁后改 width → height 按 ratio 联动（bWo 批量更新）', () => {
    const onUpdate = mock(() => {})
    // width=100, height=50 → 比例 w/h = 2；改 width=200 → height=200/2=100
    const declarations = [decl('width', '100px', '80px'), decl('height', '50px', '40px')]
    const c = render(<DesignEditor activeDesignChange={baseChange(declarations)} onUpdate={onUpdate} onDelete={() => {}} onToggleOriginalView={() => {}} />)
    // 1. 点 dimensions 锁按钮（捕获 ratio = 100/50 = 2）
    const lockBtn = c.querySelector('button.design-lock-btn[data-lock="dimensions"]') as HTMLButtonElement
    expect(lockBtn).toBeTruthy()
    act(() => lockBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    // 2. 改 width → '200px'：px number input value='200'，DeclarationInput onChange 重附 'px'
    const widthInput = c.querySelector('[data-property="width"] input') as HTMLInputElement
    const onChange = getHandler(widthInput, 'onChange')
    act(() => onChange({ target: { value: '200' } }))
    // 3. 提交 → onUpdate：width='200px'，height 按 ratio='100px'
    const submitBtn = c.querySelector('button.design-editor-submit') as HTMLButtonElement
    act(() => submitBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    const arg = onUpdate.mock.calls[0]?.[0] as ActiveDesignChange
    expect(arg.declarations.find((d) => d.property === 'width')?.value).toBe('200px')
    expect(arg.declarations.find((d) => d.property === 'height')?.value).toBe('100px')
    document.body.innerHTML = ''
  })

  test('dimensions 比例锁：反向（改 height → width 按 ratio 联动）', () => {
    const onUpdate = mock(() => {})
    // width=100, height=50 → ratio=2；改 height=80 → width=80*2=160
    const declarations = [decl('width', '100px', '80px'), decl('height', '50px', '40px')]
    const c = render(<DesignEditor activeDesignChange={baseChange(declarations)} onUpdate={onUpdate} onDelete={() => {}} onToggleOriginalView={() => {}} />)
    const lockBtn = c.querySelector('button.design-lock-btn[data-lock="dimensions"]') as HTMLButtonElement
    act(() => lockBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    const heightInput = c.querySelector('[data-property="height"] input') as HTMLInputElement
    const onChange = getHandler(heightInput, 'onChange')
    act(() => onChange({ target: { value: '80' } }))
    const submitBtn = c.querySelector('button.design-editor-submit') as HTMLButtonElement
    act(() => submitBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    const arg = onUpdate.mock.calls[0]?.[0] as ActiveDesignChange
    expect(arg.declarations.find((d) => d.property === 'height')?.value).toBe('80px')
    expect(arg.declarations.find((d) => d.property === 'width')?.value).toBe('160px')
    document.body.innerHTML = ''
  })

  test('dimensions 解锁后：改 width → height 保持不变', () => {
    const onUpdate = mock(() => {})
    const declarations = [decl('width', '100px', '80px'), decl('height', '50px', '40px')]
    const c = render(<DesignEditor activeDesignChange={baseChange(declarations)} onUpdate={onUpdate} onDelete={() => {}} onToggleOriginalView={() => {}} />)
    const lockBtn = c.querySelector('button.design-lock-btn[data-lock="dimensions"]') as HTMLButtonElement
    // 锁 → 解锁
    act(() => lockBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    act(() => lockBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    const widthInput = c.querySelector('[data-property="width"] input') as HTMLInputElement
    const onChange = getHandler(widthInput, 'onChange')
    act(() => onChange({ target: { value: '200' } }))
    const submitBtn = c.querySelector('button.design-editor-submit') as HTMLButtonElement
    act(() => submitBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    const arg = onUpdate.mock.calls[0]?.[0] as ActiveDesignChange
    expect(arg.declarations.find((d) => d.property === 'width')?.value).toBe('200px')
    // height 未联动
    expect(arg.declarations.find((d) => d.property === 'height')?.value).toBe('50px')
    document.body.innerHTML = ''
  })

  test('spacing 对边锁 vertical：改 marginTop → marginBottom 同值', () => {
    const onUpdate = mock(() => {})
    const declarations = [
      decl('marginTop', '10px', '5px'),
      decl('marginRight', '20px', '15px'),
      decl('marginBottom', '10px', '5px'),
      decl('marginLeft', '20px', '15px'),
    ]
    const c = render(<DesignEditor activeDesignChange={baseChange(declarations)} onUpdate={onUpdate} onDelete={() => {}} onToggleOriginalView={() => {}} />)
    const vLock = c.querySelector('button.design-lock-btn[data-lock="margin:vertical"]') as HTMLButtonElement
    expect(vLock).toBeTruthy()
    act(() => vLock.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    const marginTopInput = c.querySelector('[data-property="marginTop"] input') as HTMLInputElement
    const onChange = getHandler(marginTopInput, 'onChange')
    act(() => onChange({ target: { value: '30' } }))
    const submitBtn = c.querySelector('button.design-editor-submit') as HTMLButtonElement
    act(() => submitBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    const arg = onUpdate.mock.calls[0]?.[0] as ActiveDesignChange
    expect(arg.declarations.find((d) => d.property === 'marginTop')?.value).toBe('30px')
    expect(arg.declarations.find((d) => d.property === 'marginBottom')?.value).toBe('30px')
    // 左右未联动
    expect(arg.declarations.find((d) => d.property === 'marginLeft')?.value).toBe('20px')
    expect(arg.declarations.find((d) => d.property === 'marginRight')?.value).toBe('20px')
    document.body.innerHTML = ''
  })

  test('spacing 对边锁 horizontal：改 paddingLeft → paddingRight 同值', () => {
    const onUpdate = mock(() => {})
    const declarations = [
      decl('paddingTop', '10px', '5px'),
      decl('paddingRight', '20px', '15px'),
      decl('paddingBottom', '10px', '5px'),
      decl('paddingLeft', '20px', '15px'),
    ]
    const c = render(<DesignEditor activeDesignChange={baseChange(declarations)} onUpdate={onUpdate} onDelete={() => {}} onToggleOriginalView={() => {}} />)
    const hLock = c.querySelector('button.design-lock-btn[data-lock="padding:horizontal"]') as HTMLButtonElement
    expect(hLock).toBeTruthy()
    act(() => hLock.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    const paddingLeftInput = c.querySelector('[data-property="paddingLeft"] input') as HTMLInputElement
    const onChange = getHandler(paddingLeftInput, 'onChange')
    act(() => onChange({ target: { value: '40' } }))
    const submitBtn = c.querySelector('button.design-editor-submit') as HTMLButtonElement
    act(() => submitBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    const arg = onUpdate.mock.calls[0]?.[0] as ActiveDesignChange
    expect(arg.declarations.find((d) => d.property === 'paddingLeft')?.value).toBe('40px')
    expect(arg.declarations.find((d) => d.property === 'paddingRight')?.value).toBe('40px')
    document.body.innerHTML = ''
  })

  test('spacing 锁可独立切换（vertical 锁不影响 horizontal）', () => {
    const onUpdate = mock(() => {})
    const declarations = [
      decl('marginTop', '10px', '5px'),
      decl('marginRight', '20px', '15px'),
      decl('marginBottom', '10px', '5px'),
      decl('marginLeft', '20px', '15px'),
    ]
    const c = render(<DesignEditor activeDesignChange={baseChange(declarations)} onUpdate={onUpdate} onDelete={() => {}} onToggleOriginalView={() => {}} />)
    // 仅锁 vertical
    const vLock = c.querySelector('button.design-lock-btn[data-lock="margin:vertical"]') as HTMLButtonElement
    act(() => vLock.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    // 改 marginLeft（horizontal 未锁）→ marginRight 不联动
    const marginLeftInput = c.querySelector('[data-property="marginLeft"] input') as HTMLInputElement
    const onChange = getHandler(marginLeftInput, 'onChange')
    act(() => onChange({ target: { value: '99' } }))
    const submitBtn = c.querySelector('button.design-editor-submit') as HTMLButtonElement
    act(() => submitBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    const arg = onUpdate.mock.calls[0]?.[0] as ActiveDesignChange
    expect(arg.declarations.find((d) => d.property === 'marginLeft')?.value).toBe('99px')
    expect(arg.declarations.find((d) => d.property === 'marginRight')?.value).toBe('20px')
    document.body.innerHTML = ''
  })
})

// scrub peer 高亮（Codex bWo）：拖 number input 时，若该属性有 peer（width⇄height / marginTop⇄marginBottom 等），
// 高亮两 cell（data-scrub-value-cell + data-peer）。
// happy-dom 无全局 PointerEvent：fiber-key 取 useScrub 返回的 onPointerDown 直接调用，传入 mock 事件对象。
// pointerup 通过 document.dispatchEvent(new MouseEvent('pointerup')) 触发 useScrub 注册的文档监听。
describe('DesignEditor scrub peer 高亮', () => {
  // 构造 mock PointerEvent-like（happy-dom 无全局 PointerEvent；fiber-key 直接调用 handler）。
  const makeDownEvent = (): unknown => ({
    button: 0,
    isPrimary: true,
    pointerType: 'mouse',
    clientY: 100,
    pointerId: 1,
    preventDefault: () => {},
    currentTarget: { setPointerCapture: () => {} },
  })

  test('scrub width：width cell data-scrub-value-cell=true，height cell data-peer=true', () => {
    const declarations = [decl('width', '100px', '80px'), decl('height', '50px', '40px')]
    const c = render(<DesignEditor activeDesignChange={baseChange(declarations)} onUpdate={() => {}} onDelete={() => {}} onToggleOriginalView={() => {}} />)
    const widthInput = c.querySelector('[data-property="width"] input') as HTMLInputElement
    const onPointerDown = getHandler<(e: unknown) => void>(widthInput, 'onPointerDown')
    act(() => onPointerDown(makeDownEvent()))
    const widthCell = c.querySelector('[data-property="width"]') as HTMLElement
    const heightCell = c.querySelector('[data-property="height"]') as HTMLElement
    expect(widthCell.getAttribute('data-scrub-value-cell')).toBe('true')
    expect(heightCell.getAttribute('data-peer')).toBe('true')
    document.body.innerHTML = ''
  })

  test('scrub pointerup：高亮 data-attr 清空', () => {
    const declarations = [decl('width', '100px', '80px'), decl('height', '50px', '40px')]
    const c = render(<DesignEditor activeDesignChange={baseChange(declarations)} onUpdate={() => {}} onDelete={() => {}} onToggleOriginalView={() => {}} />)
    const widthInput = c.querySelector('[data-property="width"] input') as HTMLInputElement
    const onPointerDown = getHandler<(e: unknown) => void>(widthInput, 'onPointerDown')
    act(() => onPointerDown(makeDownEvent()))
    // pointerup → useScrub 还原 + onScrubActive(false) → scrubbingProperty=null
    act(() => document.dispatchEvent(new MouseEvent('pointerup')))
    const widthCell = c.querySelector('[data-property="width"]') as HTMLElement
    const heightCell = c.querySelector('[data-property="height"]') as HTMLElement
    expect(widthCell.getAttribute('data-scrub-value-cell')).toBeNull()
    expect(heightCell.getAttribute('data-peer')).toBeNull()
    document.body.innerHTML = ''
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    document.documentElement.style.overscrollBehavior = ''
  })

  test('scrub paddingTop：paddingBottom cell data-peer=true（spacing 对边 peer）', () => {
    const declarations = [
      decl('paddingTop', '10px', '5px'),
      decl('paddingBottom', '10px', '5px'),
    ]
    const c = render(<DesignEditor activeDesignChange={baseChange(declarations)} onUpdate={() => {}} onDelete={() => {}} onToggleOriginalView={() => {}} />)
    const paddingTopInput = c.querySelector('[data-property="paddingTop"] input') as HTMLInputElement
    const onPointerDown = getHandler<(e: unknown) => void>(paddingTopInput, 'onPointerDown')
    act(() => onPointerDown(makeDownEvent()))
    const topCell = c.querySelector('[data-property="paddingTop"]') as HTMLElement
    const bottomCell = c.querySelector('[data-property="paddingBottom"]') as HTMLElement
    expect(topCell.getAttribute('data-scrub-value-cell')).toBe('true')
    expect(bottomCell.getAttribute('data-peer')).toBe('true')
    act(() => document.dispatchEvent(new MouseEvent('pointerup')))
    document.body.innerHTML = ''
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    document.documentElement.style.overscrollBehavior = ''
  })
})
