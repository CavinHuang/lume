import { release } from 'node:os'

/** Apple 把 macOS 26 映射到 Darwin 25。后续 macOS 用更大 Darwin 主版本号。 */
const MACOS_26_DARWIN_MAJOR = 25

/** macOS 26+（Liquid Glass 菜单栏处理）才支持原生灵动岛面板。 */
export function isMacOS26OrLater(darwinRelease: string = release()): boolean {
  const darwinMajor = Number.parseInt(darwinRelease.split('.')[0] ?? '', 10)
  return Number.isFinite(darwinMajor) && darwinMajor >= MACOS_26_DARWIN_MAJOR
}

/** 原生灵动岛仅在 macOS 26+ 启用；其他平台走 Electron 透明窗回退。 */
export function isMacOS26NativeIslandCapable(
  platform: string = process.platform,
  darwinRelease: string = release(),
): boolean {
  return platform === 'darwin' && isMacOS26OrLater(darwinRelease)
}
