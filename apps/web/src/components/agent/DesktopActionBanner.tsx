import { useState } from 'react'
import { useSetAtom } from 'jotai'
import { Crosshair, MonitorUp, ShieldAlert, ShieldCheck } from 'lucide-react'
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
            {request.securityWarning === 'suspected_prompt_injection' ? (
              <div className="mt-2 flex items-start gap-1.5 rounded-xl border border-destructive/20 bg-destructive/5 px-2.5 py-2 text-xs text-destructive">
                <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
                <span>页面中检测到疑似提示注入内容。请只在该操作符合你的原始意图时允许。</span>
              </div>
            ) : null}
            {(request.expectedWindow || request.expectedWindowId || request.targetPoint || request.expectedRevision) ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {request.expectedWindow || request.expectedWindowId ? (
                  <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-white/70 px-2 py-0.5 text-[11px] text-amber-800">
                    <MonitorUp size={11} />
                    目标窗口 {request.expectedWindow?.title || request.expectedWindowId}
                  </span>
                ) : null}
                {request.targetPoint ? (
                  <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-white/70 px-2 py-0.5 text-[11px] text-amber-800">
                    <Crosshair size={11} />
                    目标点 {Math.round(request.targetPoint.x)},{Math.round(request.targetPoint.y)}
                  </span>
                ) : null}
                {request.expectedRevision ? (
                  <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-white/70 px-2 py-0.5 text-[11px] text-amber-800">
                    <ShieldCheck size={11} />
                    执行前复核窗口版本
                  </span>
                ) : null}
              </div>
            ) : null}
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
