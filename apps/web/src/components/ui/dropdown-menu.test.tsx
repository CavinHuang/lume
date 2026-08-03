import { describe, expect, test } from 'bun:test'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from './dropdown-menu'

describe('DropdownMenuContent', () => {
  test('is a forwardRef component so callers can attach a ref to Menu.Popup', () => {
    // BrowserShell 的 Portal 菜单需要稳定 ref，供定位、焦点和碰撞处理使用。
    expect(
      (DropdownMenuContent as unknown as { $$typeof?: symbol }).$$typeof,
    ).toBe(Symbol.for('react.forward_ref'))
  })

  test('exports the full dropdown menu surface without dropping members', () => {
    // 回归守卫：确认 ref 改造没有破坏现有导出集合
    // forwardRef 返回 object，普通函数组件返回 function
    expect(typeof DropdownMenu).toBe('function')
    expect(typeof DropdownMenuTrigger).toBe('function')
    expect(typeof DropdownMenuContent).toBe('object')
    expect(typeof DropdownMenuItem).toBe('function')
    expect(typeof DropdownMenuSeparator).toBe('function')
    expect(typeof DropdownMenuSub).toBe('function')
    expect(typeof DropdownMenuSubTrigger).toBe('function')
    expect(typeof DropdownMenuSubContent).toBe('function')
  })
})
