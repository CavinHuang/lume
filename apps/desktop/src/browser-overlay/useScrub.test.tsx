// TDD tests for useScrub hook（number input 拖拽 scrub，对齐 Codex gWo @8904954）。
// happy-dom 未注册全局 PointerEvent（见 scripts/test-dom-preload.ts）：
//   - onPointerDown 从 fiber-key 取 hook 返回的 handler 直接调用，传入 mock PointerEvent-like 对象
//     （断言守卫条件与初始会话状态）。
//   - pointermove/up/cancel 通过 document.dispatchEvent(new MouseEvent('pointermove', ...)) 触发：
//     hook 用 document.addEventListener 注册原生监听器，MouseEvent 的 type='pointermove' 与监听器
//     匹配（listener 匹配按 type 字符串），等价于真实 PointerEvent 派发——非空洞（real handler +
//     real PointerEvent 字段 + real body 副作用断言）。
import { describe, test, expect, mock } from 'bun:test'
import { electronMockStub } from '../../scripts/test-electron-mock'
await mock.module('electron', () => electronMockStub)
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { ReactNode, PointerEvent as ReactPointerEvent } from 'react'
const { useScrub } = await import('./useScrub')
import type { UseScrubOptions } from './useScrub'

// 渲染宿主组件调用 hook，返回的 onPointerDown/scrubbing 暴露到 ref。
// 跟踪 activeRoot：下一次 renderHook 先 unmount 上一个 root，触发 useEffect cleanup
// （移除文档监听 + 还原 body），避免跨测试泄漏。
let activeRoot: ReturnType<typeof createRoot> | null = null
function renderHook<T>(useFn: () => T): { current: T } {
  if (activeRoot) { act(() => { activeRoot!.unmount() }); activeRoot = null }
  const ref: { current: T } = { current: null as unknown as T }
  function Probe(): ReactNode { ref.current = useFn(); return null }
  const container = document.createElement('div')
  document.body.append(container)
  activeRoot = createRoot(container)
  act(() => { activeRoot.render(<Probe />) })
  return ref
}

// 构造 mock PointerEvent-like（happy-dom 无全局 PointerEvent；fiber-key 直接调用 handler）。
// currentTarget 提供 setPointerCapture 桩（生产 Electron 上是真实方法）。
const makeDownEvent = (overrides: Partial<{
  clientY: number
  button: number
  isPrimary: boolean
  pointerType: string
  pointerId: number
}> = {}): ReactPointerEvent => ({
  button: 0,
  isPrimary: true,
  pointerType: 'mouse',
  clientY: 100,
  pointerId: 1,
  preventDefault: () => {},
  currentTarget: { setPointerCapture: () => {} } as unknown as EventTarget,
  ...overrides,
} as unknown as ReactPointerEvent)

const baseOpts = (overrides: Partial<UseScrubOptions> = {}): UseScrubOptions => ({
  value: 0.5,
  min: 0,
  max: 1,
  step: 0.01,
  onChange: () => {},
  ...overrides,
})

// 派发 document 级 pointer 事件（hook 用 document.addEventListener 注册监听）。
const dispatchMove = (clientY: number): void => {
  document.dispatchEvent(new MouseEvent('pointermove', { clientY }))
}
const dispatchUp = (): void => {
  document.dispatchEvent(new MouseEvent('pointerup'))
}
const dispatchCancel = (): void => {
  document.dispatchEvent(new MouseEvent('pointercancel'))
}

// 测试隔离：每个 test 收尾卸载 root + 清空 DOM + 还原 body/documentElement 残留 style。
const resetEnv = (): void => {
  if (activeRoot) { act(() => { activeRoot!.unmount() }); activeRoot = null }
  document.body.innerHTML = ''
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
  document.documentElement.style.overscrollBehavior = ''
}

describe('useScrub - 守卫条件', () => {
  test('初始 scrubbing=false', () => {
    const ref = renderHook(() => useScrub(baseOpts()))
    expect(ref.current.scrubbing).toBe(false)
    resetEnv()
  })

  test('button !== 0：不进入 scrub（无 body 锁定 + 后续 move 不触发 onChange）', () => {
    const onChange = mock(() => {})
    const ref = renderHook(() => useScrub(baseOpts({ onChange })))
    act(() => ref.current.onPointerDown(makeDownEvent({ button: 2 })))
    expect(ref.current.scrubbing).toBe(false)
    expect(document.body.style.cursor).toBe('')
    act(() => dispatchMove(96))
    expect(onChange).toHaveBeenCalledTimes(0)
    resetEnv()
  })

  test('pointerType === touch：不进入 scrub', () => {
    const onChange = mock(() => {})
    const ref = renderHook(() => useScrub(baseOpts({ onChange })))
    act(() => ref.current.onPointerDown(makeDownEvent({ pointerType: 'touch' })))
    expect(ref.current.scrubbing).toBe(false)
    act(() => dispatchMove(96))
    expect(onChange).toHaveBeenCalledTimes(0)
    resetEnv()
  })

  test('!isPrimary：不进入 scrub', () => {
    const onChange = mock(() => {})
    const ref = renderHook(() => useScrub(baseOpts({ onChange })))
    act(() => ref.current.onPointerDown(makeDownEvent({ isPrimary: false })))
    expect(ref.current.scrubbing).toBe(false)
    resetEnv()
  })
})

describe('useScrub - 垂直拖拽与 4px 阈值', () => {
  test('向上拖 4px（currentY 减小）→ onChange(value + step)', () => {
    const onChange = mock(() => {})
    const ref = renderHook(() => useScrub(baseOpts({ value: 0.5, step: 0.01, onChange })))
    act(() => ref.current.onPointerDown(makeDownEvent({ clientY: 100 })))
    expect(ref.current.scrubbing).toBe(true)
    act(() => dispatchMove(96)) // 100-96=4 → delta=1 → 0.5+0.01=0.51
    expect(onChange.mock.calls[0]?.[0]).toBe(0.51)
    resetEnv()
  })

  test('向下拖 4px（currentY 增大）→ onChange(value - step)', () => {
    const onChange = mock(() => {})
    const ref = renderHook(() => useScrub(baseOpts({ value: 0.5, step: 0.01, onChange })))
    act(() => ref.current.onPointerDown(makeDownEvent({ clientY: 100 })))
    act(() => dispatchMove(104)) // 100-104=-4 → delta=-1 → 0.5-0.01=0.49
    expect(onChange.mock.calls[0]?.[0]).toBe(0.49)
    resetEnv()
  })

  test('<4px 不触发 onChange（gGo 防误触阈值）', () => {
    const onChange = mock(() => {})
    const ref = renderHook(() => useScrub(baseOpts({ value: 0.5, step: 0.01, onChange })))
    act(() => ref.current.onPointerDown(makeDownEvent({ clientY: 100 })))
    act(() => dispatchMove(98)) // 2px → delta=0 → 跳过
    expect(onChange).toHaveBeenCalledTimes(0)
    resetEnv()
  })

  test('8px → delta=trunc(8/4)=2 → onChange +2 step', () => {
    const onChange = mock(() => {})
    const ref = renderHook(() => useScrub(baseOpts({ value: 0.5, step: 0.01, onChange })))
    act(() => ref.current.onPointerDown(makeDownEvent({ clientY: 100 })))
    act(() => dispatchMove(92)) // 8px → delta=2 → 0.5+0.02=0.52
    expect(onChange.mock.calls[0]?.[0]).toBe(0.52)
    resetEnv()
  })

  test('px step=1：value=16 向上 4px → 17', () => {
    const onChange = mock(() => {})
    const ref = renderHook(() => useScrub(baseOpts({ value: 16, step: 1, min: undefined, max: undefined, onChange })))
    act(() => ref.current.onPointerDown(makeDownEvent({ clientY: 100 })))
    act(() => dispatchMove(96))
    expect(onChange.mock.calls[0]?.[0]).toBe(17)
    resetEnv()
  })
})

describe('useScrub - clamp（XWo）与格式化（YWo）', () => {
  test('clamp max=1：向上拖越界 → 不超过 1', () => {
    const onChange = mock(() => {})
    const ref = renderHook(() => useScrub(baseOpts({ value: 0.99, step: 0.01, min: 0, max: 1, onChange })))
    act(() => ref.current.onPointerDown(makeDownEvent({ clientY: 100 })))
    act(() => dispatchMove(50)) // 50px → delta=12 → 0.99+0.12=1.11 clamp 1
    expect(onChange.mock.calls[0]?.[0]).toBe(1)
    resetEnv()
  })

  test('clamp min=0：向下拖越界 → 不低于 0', () => {
    const onChange = mock(() => {})
    const ref = renderHook(() => useScrub(baseOpts({ value: 0.01, step: 0.01, min: 0, max: 1, onChange })))
    act(() => ref.current.onPointerDown(makeDownEvent({ clientY: 100 })))
    act(() => dispatchMove(150)) // 50px → delta=-12 → 0.01-0.12=-0.11 clamp 0
    expect(onChange.mock.calls[0]?.[0]).toBe(0)
    resetEnv()
  })

  test('格式化 YWo：step=0.01 + value=0.5 + 拖 5px（delta=1）→ 0.51（2 位小数）', () => {
    const onChange = mock(() => {})
    const ref = renderHook(() => useScrub(baseOpts({ value: 0.5, step: 0.01, onChange })))
    act(() => ref.current.onPointerDown(makeDownEvent({ clientY: 100 })))
    act(() => dispatchMove(95))
    expect(onChange.mock.calls[0]?.[0]).toBe(0.51)
    resetEnv()
  })

  test('格式化 YWo：浮点累计四舍五入到 2 位（避免 0.30000000004）', () => {
    const onChange = mock(() => {})
    // value=0.3 + step 0.01 → 累计 delta=1 应得 0.31（不产生浮点尾差）
    const ref = renderHook(() => useScrub(baseOpts({ value: 0.3, step: 0.01, onChange })))
    act(() => ref.current.onPointerDown(makeDownEvent({ clientY: 100 })))
    act(() => dispatchMove(96))
    expect(onChange.mock.calls[0]?.[0]).toBe(0.31)
    resetEnv()
  })
})

describe('useScrub - body 锁定与还原', () => {
  test('进入 scrub：body cursor=ns-resize + userSelect=none + documentElement overscrollBehavior=none', () => {
    const ref = renderHook(() => useScrub(baseOpts()))
    act(() => ref.current.onPointerDown(makeDownEvent({ clientY: 100 })))
    expect(document.body.style.cursor).toBe('ns-resize')
    expect(document.body.style.userSelect).toBe('none')
    expect(document.documentElement.style.overscrollBehavior).toBe('none')
    resetEnv()
  })

  test('scrollContainer overflowY=hidden（[data-browser-sidebar-design-scroll-container]）', () => {
    const scroll = document.createElement('div')
    scroll.setAttribute('data-browser-sidebar-design-scroll-container', '')
    document.body.append(scroll)
    const ref = renderHook(() => useScrub(baseOpts()))
    act(() => ref.current.onPointerDown(makeDownEvent({ clientY: 100 })))
    expect(scroll.style.overflowY).toBe('hidden')
    act(() => dispatchUp())
    expect(scroll.style.overflowY).toBe('')
    resetEnv()
  })

  test('onScrubActive(true) 在 pointerDown 时触发', () => {
    const onScrubActive = mock(() => {})
    const ref = renderHook(() => useScrub(baseOpts({ onScrubActive })))
    act(() => ref.current.onPointerDown(makeDownEvent({ clientY: 100 })))
    expect(onScrubActive.mock.calls[0]?.[0]).toBe(true)
    resetEnv()
  })

  test('pointerUp：还原 body + scrubbing=false + onScrubActive(false)', () => {
    const onScrubActive = mock(() => {})
    const ref = renderHook(() => useScrub(baseOpts({ onScrubActive })))
    act(() => ref.current.onPointerDown(makeDownEvent({ clientY: 100 })))
    act(() => dispatchUp())
    expect(document.body.style.cursor).toBe('')
    expect(document.body.style.userSelect).toBe('')
    expect(document.documentElement.style.overscrollBehavior).toBe('')
    expect(ref.current.scrubbing).toBe(false)
    expect(onScrubActive.mock.calls[1]?.[0]).toBe(false)
    resetEnv()
  })

  test('pointercancel：同 pointerUp 还原', () => {
    const onScrubActive = mock(() => {})
    const ref = renderHook(() => useScrub(baseOpts({ onScrubActive })))
    act(() => ref.current.onPointerDown(makeDownEvent({ clientY: 100 })))
    act(() => dispatchCancel())
    expect(ref.current.scrubbing).toBe(false)
    expect(document.body.style.cursor).toBe('')
    expect(onScrubActive.mock.calls[1]?.[0]).toBe(false)
    resetEnv()
  })

  test('pointerUp 后再次 pointermove 不触发 onChange（监听器已移除）', () => {
    const onChange = mock(() => {})
    const ref = renderHook(() => useScrub(baseOpts({ onChange })))
    act(() => ref.current.onPointerDown(makeDownEvent({ clientY: 100 })))
    act(() => dispatchUp())
    act(() => dispatchMove(96))
    expect(onChange).toHaveBeenCalledTimes(0)
    resetEnv()
  })
})
