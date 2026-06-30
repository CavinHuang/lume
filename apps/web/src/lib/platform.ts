import { isDesktopRuntime } from '@/lib/desktop-runtime/core'

/**
 * 是否运行在 macOS 桌面端（Electron shell）。
 * 仅此场景使用 titleBarStyle: Overlay，需要在顶部为系统红绿灯按钮预留空间并保留拖拽区；
 * Windows/Linux 有原生标题栏，浏览器无红绿灯，均不需预留。
 */
export const isMacosDesktopShell = isDesktopRuntime()
  && /Mac/i.test(typeof navigator !== 'undefined' ? navigator.userAgent : '')
