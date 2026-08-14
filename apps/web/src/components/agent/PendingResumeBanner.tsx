import { useCallback, useEffect, useRef, useState } from 'react'
import { History, Play, X } from 'lucide-react'
import { getAgentPendingResume, resumeAgentRun } from '@/lib/desktop-api'
import { Button } from '@/components/ui/button'

export interface PendingResumeBannerProps {
  threadId: string
}

type PendingResumeState =
  | { phase: 'hidden' }
  | { phase: 'prompt'; runId?: string; reason?: string }
  | { phase: 'notice'; message: string }

/**
 * 「放弃」= 本次应用运行周期内不再提示该线程（前端记录）。
 * ponytail: phase 1 未补 sidecar discard 通道（不动 session）；若需要跨重启静默，
 * 升级为 agent:discard-interrupted-run IPC 持久清理。
 */
const dismissedThreadIds = new Set<string>()

/**
 * 待恢复中断提示横幅。线程打开时查询 agent:get-pending-resume，
 * 有待恢复 run 则提示用户「继续」（agent:resume-run）或「放弃」（本地忽略）。
 * resume 返回 not_resumable/failed 时以友好文案提示，不弹错误。
 */
export function PendingResumeBanner({ threadId }: PendingResumeBannerProps) {
  const [state, setState] = useState<PendingResumeState>({ phase: 'hidden' })
  const [resuming, setResuming] = useState(false)
  const resumingRef = useRef(false)

  useEffect(() => {
    // threadId 原地切换（AgentView 不重挂）时无条件重置，防止上一线程的横幅残留
    setState({ phase: 'hidden' })
    if (dismissedThreadIds.has(threadId)) return
    let cancelled = false
    getAgentPendingResume(threadId)
      .then((result) => {
        if (cancelled || !result.hasPendingResume) return
        setState({ phase: 'prompt', runId: result.runId, reason: result.reason })
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [threadId])

  const handleResume = useCallback(async () => {
    // ref 守卫：同步双击下 state 闭包仍是旧值，ref 跨闭包即时生效
    if (resumingRef.current) return
    resumingRef.current = true
    setResuming(true)
    const runId = state.phase === 'prompt' ? state.runId : undefined
    try {
      const result = await resumeAgentRun({ threadId, ...(runId ? { runId } : {}) })
      if (result.status === 'not_resumable' || result.status === 'failed') {
        setState({ phase: 'notice', message: '该任务无法自动恢复，可发送新消息重新开始' })
        return
      }
      // resumed / waiting_for_approval / waiting_for_user：续跑或转交互横幅接管
      setState({ phase: 'hidden' })
    } catch {
      setState({ phase: 'notice', message: '该任务无法自动恢复，可发送新消息重新开始' })
    } finally {
      resumingRef.current = false
      setResuming(false)
    }
  }, [state, threadId])

  const handleDismiss = useCallback(() => {
    dismissedThreadIds.add(threadId)
    setState({ phase: 'hidden' })
  }, [threadId])

  if (state.phase === 'hidden') return null

  if (state.phase === 'notice') {
    return (
      <div data-pending-resume-banner="notice" className="mx-auto mb-2 flex max-w-[980px] items-center gap-2.5 rounded-xl border border-border bg-muted/40 px-4 py-3">
        <History size={16} className="shrink-0 text-muted-foreground" />
        <p className="min-w-0 flex-1 text-[13px] text-muted-foreground">{state.message}</p>
        <Button variant="ghost" onClick={() => setState({ phase: 'hidden' })} className="size-6 p-1 text-muted-foreground" title="关闭">
          <X size={14} />
        </Button>
      </div>
    )
  }

  return (
    <div data-pending-resume-banner="prompt" className="mx-auto mb-2 flex max-w-[980px] items-center gap-2.5 rounded-xl border border-border bg-muted/40 px-4 py-3">
      <History size={16} className="shrink-0 text-muted-foreground" />
      <p className="min-w-0 flex-1 text-[13px] text-foreground">上次有未完成任务，是否继续？</p>
      <Button
        variant="ghost"
        data-pending-resume-action="resume"
        disabled={resuming}
        onClick={handleResume}
        className="h-7 gap-1 rounded-full border border-border px-2.5 text-[11px] font-semibold text-foreground hover:bg-accent"
      >
        <Play size={13} />
        继续
      </Button>
      <Button
        variant="ghost"
        data-pending-resume-action="discard"
        onClick={handleDismiss}
        className="h-7 gap-1 rounded-full border border-border px-2.5 text-[11px] font-semibold text-muted-foreground hover:text-foreground"
      >
        <X size={13} />
        放弃
      </Button>
    </div>
  )
}
