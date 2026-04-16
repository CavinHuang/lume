import { useSetAtom } from 'jotai'
import { ShieldAlert, Shield } from 'lucide-react'
import { cn } from '@/lib/utils'
import { agentPendingInteractiveAtom } from '@/atoms'
import { sidecarCall } from '@/lib/desktop-api'
import type { AgentToolPermissionRequest } from '@lume/shared'

interface PermissionBannerProps {
  threadId: string
  request: AgentToolPermissionRequest
}

const riskIcon = { low: Shield, medium: ShieldAlert, high: ShieldAlert }
const riskColor = {
  low: 'border-blue-500/30 bg-blue-500/5',
  medium: 'border-yellow-500/30 bg-yellow-500/5',
  high: 'border-red-500/30 bg-red-500/5',
}

export function PermissionBanner({ threadId, request }: PermissionBannerProps) {
  const setPending = useSetAtom(agentPendingInteractiveAtom)

  const respond = async (decision: 'allow_once' | 'allow_always' | 'deny') => {
    await sidecarCall('agent:submit-tool-permission', { threadId, requestId: request.requestId, decision })
    setPending((prev) => {
      const next = { ...prev }
      if (next[threadId]) next[threadId] = { ...next[threadId], toolPermission: undefined }
      return next
    })
  }

  const Icon = riskIcon[request.risk]

  return (
    <div className={cn('animate-in slide-in-from-bottom-2 duration-200 mx-4 mb-3 rounded-xl border bg-card shadow-lg', riskColor[request.risk])}>
      <div className="flex items-start gap-3 p-3">
        <Icon size={16} className="mt-0.5 flex-shrink-0 text-foreground/60" />
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-medium text-foreground">{request.toolName}</p>
          <p className="text-[12px] text-foreground/60 mt-0.5">{request.reason}</p>
        </div>
      </div>
      <div className="flex items-center gap-2 px-3 pb-3">
        <button onClick={() => respond('allow_once')} className="px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-[12px] font-medium hover:opacity-90 transition-opacity">
          允许一次
        </button>
        <button onClick={() => respond('allow_always')} className="px-3 py-1.5 rounded-lg bg-muted text-foreground/70 text-[12px] hover:bg-muted/80 transition-colors">
          始终允许
        </button>
        <button onClick={() => respond('deny')} className="px-3 py-1.5 rounded-lg text-destructive text-[12px] hover:bg-destructive/10 transition-colors">
          拒绝
        </button>
      </div>
    </div>
  )
}
