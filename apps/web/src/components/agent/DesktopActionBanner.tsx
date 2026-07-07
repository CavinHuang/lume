import { useState } from 'react'
import { useSetAtom } from 'jotai'
import { MonitorUp } from 'lucide-react'
import type { AgentDesktopActionRequest, AgentDesktopActionResponseInput } from '@lume/shared'
import { AGENT_IPC_CHANNELS } from '@lume/shared'
import { agentPendingInteractiveAtom } from '@/atoms'
import { removePendingDesktopActionRequest } from '@/hooks/pending-interactive-state'
import { sidecarCall } from '@/lib/desktop-api'
import { Button } from '@/components/ui/button'
import { InteractiveOverlayFrame } from './InteractiveOverlayFrame'

export function DesktopActionBanner({
  threadId,
  request,
}: {
  threadId: string
  request: AgentDesktopActionRequest
}) {
  const setPending = useSetAtom(agentPendingInteractiveAtom)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const respond = async (decision: AgentDesktopActionResponseInput['decision']) => {
    setBusy(true)
    setError(null)
    try {
      await sidecarCall(AGENT_IPC_CHANNELS.SUBMIT_DESKTOP_ACTION, {
        threadId,
        requestId: request.requestId,
        decision,
      } satisfies AgentDesktopActionResponseInput)
      setPending((prev) => removePendingDesktopActionRequest(prev, threadId, request.requestId))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '提交失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <InteractiveOverlayFrame
      kind="tool-permission"
      title="确认桌面操作"
      busy={busy}
      onIgnore={() => void respond('deny')}
      onSubmit={() => void respond('allow_once')}
    >
      <div className="space-y-3">
        <div className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-3">
          <MonitorUp className="mt-0.5 size-5 shrink-0 text-amber-700" />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-foreground">{request.summary}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Lume 会在执行前重新验证窗口和目标状态。本次允许不会保存为长期授权。
            </p>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" disabled={busy} onClick={() => void respond('deny')}>
            拒绝
          </Button>
          <Button type="button" disabled={busy} onClick={() => void respond('allow_once')}>
            允许一次
          </Button>
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
    </InteractiveOverlayFrame>
  )
}
