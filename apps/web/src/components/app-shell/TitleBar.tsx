/**
 * TitleBar - Tauri 自定义标题栏
 *
 * 使用 data-tauri-drag-region 属性实现窗口拖拽。
 * macOS 上保留左上角红绿灯按钮空间。
 */

import type { MouseEvent } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useAtomValue } from 'jotai'
import { activeTabIdAtom, tabsAtom } from '@/atoms'
import { RightPanelWindowControls } from '@/components/right-panel'
import { isMacosTauri } from '@/lib/platform'

function startTitleBarDrag(event: MouseEvent<HTMLDivElement>) {
  if (event.buttons !== 1) return
  void getCurrentWindow()
    .startDragging()
    .catch((error) => {
      console.error('[TitleBar] 启动窗口拖拽失败:', error)
    })
}

export function TitleBar() {
  const tabs = useAtomValue(tabsAtom)
  const activeTabId = useAtomValue(activeTabIdAtom)
  const activeTab = tabs.find((tab) => tab.id === activeTabId)
  const activeThreadId = activeTab?.type === 'agent' ? activeTab.threadId : undefined

  return (
    <div
      className="fixed top-0 left-0 right-0 h-[50px] z-[70] pointer-events-none select-none"
    >
      {isMacosTauri && (
        <div
          onMouseDown={startTitleBarDrag}
          className="absolute left-0 right-0 top-0 h-5 pointer-events-auto"
        />
      )}
      {activeThreadId && (
        <RightPanelWindowControls
          className="pointer-events-auto absolute right-4 top-4 z-10"
        />
      )}
    </div>
  )
}
