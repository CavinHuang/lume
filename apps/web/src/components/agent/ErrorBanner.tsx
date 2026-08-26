import { AlertTriangle, X, RotateCcw, Settings2 } from 'lucide-react'
import { useAtomValue, useSetAtom } from 'jotai'
import { agentErrorMessagesAtom, agentStreamingStatesAtom, tabsAtom, activeTabIdAtom } from '@/atoms'
import { agentSend } from '@/lib/desktop-api'
import { openSettingsTab } from '@/components/app-shell/LeftSidebar'

import { Button } from '@/components/ui/button'
interface ErrorBannerProps {
  threadId: string
}

export function ErrorBanner({ threadId }: ErrorBannerProps) {
  const errorMessages = useAtomValue(agentErrorMessagesAtom)
  const setErrorMessages = useSetAtom(agentErrorMessagesAtom)
  const setStreamingStates = useSetAtom(agentStreamingStatesAtom)
  const setTabs = useSetAtom(tabsAtom)
  const setActiveTabId = useSetAtom(activeTabIdAtom)

  const errorMsg = errorMessages[threadId]

  const handleDismiss = () => {
    setErrorMessages((prev) => {
      const next = { ...prev }
      delete next[threadId]
      return next
    })
    setStreamingStates((prev) => ({ ...prev, [threadId]: 'idle' }))
  }

  const handleRetry = async () => {
    handleDismiss()
    await agentSend({ threadId, userMessage: '请继续' })
  }

  // 动线 F6:#559 人话指引含「设置 →」时给一键入口,不再让用户自己找
  const hasSettingsGuidance = Boolean(errorMsg && errorMsg.includes('设置 →'))

  return (
    <div className="mx-4 mb-2 rounded-xl border border-destructive/30 bg-destructive/5 p-3">
      <div className="flex items-start gap-2.5">
        <AlertTriangle size={16} className="text-destructive mt-0.5 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-medium text-destructive">运行出错</p>
          {errorMsg && (
            <p className="text-[12px] text-destructive/70 mt-0.5 break-words">{errorMsg}</p>
          )}
          {hasSettingsGuidance && (
            <Button
              variant="ghost"
              onClick={() => openSettingsTab(setTabs, setActiveTabId)}
              className="mt-1.5 h-7 gap-1 rounded-md px-2 text-[11px] text-destructive/80 hover:bg-destructive/10 hover:text-destructive"
            >
              <Settings2 size={12} />
              打开设置
            </Button>
          )}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <Button
                variant="ghost"
            onClick={handleRetry}
            className="p-1 rounded-md text-destructive/60 hover:text-destructive hover:bg-destructive/10 transition-colors"
            title="重试"
          >
            <RotateCcw size={14} />
          </Button>
          <Button
                variant="ghost"
            onClick={handleDismiss}
            className="p-1 rounded-md text-destructive/60 hover:text-destructive hover:bg-destructive/10 transition-colors"
            title="关闭"
          >
            <X size={14} />
          </Button>
        </div>
      </div>
    </div>
  )
}
