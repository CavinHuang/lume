import { isDesktopRuntime } from '@/lib/desktop-runtime/core'

/** 判定 macOS 桌面端的纯函数（便于测试）。 */
export function detectIsMacosDesktopShell(
  userAgent: string | undefined,
  desktop: boolean,
): boolean {
  return desktop && /Mac/i.test(userAgent ?? '')
}

/** 判定需自绘窗口按钮的平台（Windows/Linux 桌面端）的纯函数。 */
export function detectIsCustomWindowControlsPlatform(
  userAgent: string | undefined,
  desktop: boolean,
): boolean {
  return desktop && !detectIsMacosDesktopShell(userAgent, desktop)
}

const userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : undefined
const desktop = isDesktopRuntime()

/**
 * 是否运行在 macOS 桌面端（Electron shell）。
 * 仅此场景保留系统红绿灯按钮，需要在顶部为交通灯预留空间并保留拖拽区。
 */
export const isMacosDesktopShell = detectIsMacosDesktopShell(userAgent, desktop)

/**
 * 是否需要自绘窗口控制按钮（Windows/Linux 桌面端）。
 * macOS 保留原生交通灯，浏览器/SSR 无窗口控件需求。
 */
export const isCustomWindowControlsPlatform =
  detectIsCustomWindowControlsPlatform(userAgent, desktop)
