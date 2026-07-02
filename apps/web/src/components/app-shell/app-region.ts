import type { CSSProperties } from 'react'

/** 标记元素为窗口拖拽区（Electron 在 CSS 层拦截为系统级拖拽）。 */
export const DRAG_REGION = { WebkitAppRegion: 'drag' } as CSSProperties

/** 标记元素排除拖拽，使其能正常接收点击。 */
export const NO_DRAG_REGION = { WebkitAppRegion: 'no-drag' } as CSSProperties
