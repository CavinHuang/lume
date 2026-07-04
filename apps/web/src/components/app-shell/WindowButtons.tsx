import { Button } from '@/components/ui/button'
/**
 * WindowButtons - Windows/Linux 自绘窗口控制按钮
 *
 * 视觉 token 与 RightPanelWindowControls 一致（size-8 圆角按钮）。
 * macOS 不渲染此组件（保留原生交通灯）。
 */

import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import { Copy, Minus, Square, X } from 'lucide-react'
import { getCurrentWindow } from '@/lib/desktop-runtime/window'
import { cn } from '@/lib/utils'
import { NO_DRAG_REGION } from './app-region'

interface WindowButtonGroupProps {
  maximized: boolean
  focused: boolean
  className?: string
  style?: CSSProperties
}

/** 纯展示组件，便于在 SSR 测试中覆盖两种最大化态。 */
export function WindowButtonGroup({
  maximized,
  focused,
  className,
  style,
}: WindowButtonGroupProps) {
  const buttonClass = cn(
    'flex size-8 items-center justify-center rounded-[8px] text-[var(--lume-text-muted)] transition-colors duration-150 ease-out',
    focused
      ? 'hover:bg-[var(--lume-bg-elevated)] hover:text-[var(--lume-text-primary)] active:bg-[color:color-mix(in_oklab,var(--lume-bg-elevated)_82%,black)]'
      : 'text-[color:color-mix(in_oklab,var(--lume-text-muted)_56%,transparent)]',
  )

  return (
    <div className={cn('flex items-center gap-1', className)} style={{ ...NO_DRAG_REGION, ...style }}>
      <Button
        variant="ghost"
        type="button"
        title="最小化"
        className={buttonClass}
        onClick={() => getCurrentWindow().minimize().catch(() => {})}
      >
        <Minus size={16} />
      </Button>
      <Button
        variant="ghost"
        type="button"
        title={maximized ? '还原' : '最大化'}
        className={buttonClass}
        onClick={() => getCurrentWindow().toggleMaximize().catch(() => {})}
      >
        {maximized ? <Copy size={14} /> : <Square size={14} />}
      </Button>
      <Button
                variant="ghost"
        type="button"
        title="关闭"
        className={cn(buttonClass, 'hover:bg-[color:color-mix(in_oklab,var(--lume-danger)_20%,var(--lume-bg-elevated))] hover:text-[var(--lume-text-primary)]')}
        onClick={() => getCurrentWindow().close().catch(() => {})}
      >
        <X size={16} />
      </Button>
    </div>
  )
}

export function WindowButtons({ className }: { className?: string }) {
  const [maximized, setMaximized] = useState(false)
  const [focused, setFocused] = useState(true)

  useEffect(() => {
    let active = true

    getCurrentWindow()
      .isMaximized()
      .then((value) => {
        if (active) setMaximized(value)
      })
      .catch(() => {})

    // onMaximizeStateChange 同步返回取消订阅函数（见 desktop-runtime/window.ts）。
    const unsubscribe = getCurrentWindow().onMaximizeStateChange((payload) => {
      setMaximized(Boolean(payload?.maximized))
    })

    const onBlur = () => setFocused(false)
    const onFocus = () => setFocused(true)
    window.addEventListener('blur', onBlur)
    window.addEventListener('focus', onFocus)

    return () => {
      active = false
      unsubscribe?.()
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  return <WindowButtonGroup maximized={maximized} focused={focused} className={className} />
}
