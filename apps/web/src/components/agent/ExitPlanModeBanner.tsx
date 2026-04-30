import { sidecarCall } from '@/lib/desktop-api'
import { AGENT_IPC_CHANNELS } from '@lume/shared'
import { CheckCheck, X } from 'lucide-react'

interface ExitPlanModeBannerProps {
  threadId: string
}

export function ExitPlanModeBanner({ threadId }: ExitPlanModeBannerProps) {
  const approve = () =>
    sidecarCall(AGENT_IPC_CHANNELS.SEND_THREAD_MESSAGE, { threadId, userMessage: '', permissionMode: 'acceptEdits' })

  const cancel = () =>
    sidecarCall(AGENT_IPC_CHANNELS.STOP_THREAD, { threadId })

  return (
    <div className="animate-in slide-in-from-bottom-2 duration-200 mx-4 mb-3 rounded-xl border border-primary/30 bg-primary/5 shadow-lg">
      <div className="flex items-center justify-between px-3 py-2.5">
        <p className="text-[13px] text-foreground/80">Plan 已就绪，是否开始执行？</p>
        <div className="flex items-center gap-2">
          <button onClick={approve} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-[12px] font-medium hover:opacity-90 transition-opacity">
            <CheckCheck size={13} />
            批准执行
          </button>
          <button onClick={cancel} className="p-1.5 rounded-lg text-foreground/40 hover:text-foreground/70 hover:bg-muted/50 transition-colors">
            <X size={14} />
          </button>
        </div>
      </div>
    </div>
  )
}
