/**
 * 右侧面板「浏览器」tab 宿主 —— BrowserSidePane 的应用壳挂载点。
 *
 *  - workspaceKey:与 sidecar 浏览器上下文同构(workspaceSlug ?? workspaceId ?? threadId,
 *    见 sidecar create-browser-tools.ts),agent 建 tab(browser-view-ready)与用户 tab
 *    因此落入同一工作区分桶,面板可见、可续用;缺省由面板内部退 'default' 单桶。
 *  - open-browser-url:面板未挂载时 main 转发的弹窗 URL 先落 open-browser-url-bridge
 *    暂存队列并 reveal 本 tab;本宿主挂载后认领欠账(openUrlTab)。已挂载则由面板
 *    hook 内部订阅原地建 tab,不重复。
 */
import { useEffect, useRef, useState } from 'react'
import { useSetAtom } from 'jotai'
import { BrowserSidePane } from '@/components/browser/SidePane'
import type { UseBrowserPanelResult } from '@/components/browser/useBrowserPanel'
import {
  consumePendingBrowserUrls,
  deliverOpenBrowserUrl,
  setBrowserPanelMounted,
} from '@/components/browser/open-browser-url-bridge'
import { openExternal } from '@/lib/desktop-api'
import { onBrowserViewOpenBrowserUrl } from '@/lib/desktop-api/browser-view'
import { rightPanelLayoutAtom, rightPanelWorkspaceActionAtom } from '@/atoms'

export function BrowserRightPanelWorkspace({ workspaceKey }: { workspaceKey?: string }) {
  const [panel, setPanel] = useState<UseBrowserPanelResult | null>(null)

  // 挂载/卸载登记:决定 open-browser-url 走面板内部订阅还是暂存 + reveal。
  useEffect(() => {
    setBrowserPanelMounted(true)
    return () => setBrowserPanelMounted(false)
  }, [])

  // 认领面板挂载前到达的弹窗 URL(ZCode:弹窗拦截 → 新面板 tab)。
  useEffect(() => {
    if (!panel) return
    for (const url of consumePendingBrowserUrls()) panel.openUrlTab(url)
  }, [panel])

  return <BrowserSidePane className="min-h-0 flex-1" workspaceKey={workspaceKey} onPanelReady={setPanel} />
}

/**
 * open-browser-url reveal 桥(常驻订阅,挂于 RightPanelWorkspace;须在早退 return
 * 之前调用):面板未挂载时暂存 URL 并点亮右面板「浏览器」tab;无会话上下文
 * (threadId 缺省,如设置页)时退化为系统浏览器外开 —— ZCode「无 shell →
 * window.open」回退的 Lume 等价。
 */
export function useOpenBrowserUrlReveal(threadId: string | undefined): void {
  const dispatch = useSetAtom(rightPanelWorkspaceActionAtom)
  const setLayout = useSetAtom(rightPanelLayoutAtom)
  const threadIdRef = useRef(threadId)
  threadIdRef.current = threadId

  useEffect(() => {
    let disposed = false
    const unsubs: Array<() => void> = []
    void onBrowserViewOpenBrowserUrl((payload) => {
      if (disposed || !payload.url) return
      // false = 面板已挂载,useBrowserPanel 内部订阅已建 tab;此处只补「未挂载」路径。
      if (!deliverOpenBrowserUrl(payload.url)) return
      const activeThreadId = threadIdRef.current
      if (!activeThreadId) {
        void openExternal(payload.url).catch(() => undefined)
        return
      }
      setLayout((current) => ({ ...current, open: true, mode: current.mode === 'compact' ? 'normal' : current.mode }))
      dispatch({ type: 'activate-function', threadId: activeThreadId, function: 'browser' })
    }).then((unsub) => { if (disposed) unsub(); else unsubs.push(unsub) })
    return () => {
      disposed = true
      for (const unsub of unsubs) unsub()
    }
  }, [dispatch, setLayout])
}

