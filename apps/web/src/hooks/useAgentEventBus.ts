import { getAgentEvents, onAgentEvents } from '@/lib/desktop-api/agent'
import { useEffect, useRef } from 'react'
import type { SdkEventEnvelope } from '@lume/shared'

/** snapshot = 首次挂载/线程切回的初始拉取回放;push = 实时推送与补拉对账。 */
export type AgentEventBusSource = 'snapshot' | 'push'

export interface UseAgentEventBusOptions {
  enabled: boolean
  onEvent: (e: SdkEventEnvelope, source: AgentEventBusSource) => void
}

/**
 * Consume the sidecar lifecycle event bus for one thread.
 *
 * On mount: pull a snapshot via getAgentEvents (with afterSeq when this thread
 * was seen before), then subscribe to pushes.
 *
 * The bus coalesces streaming updates on two levels (16ms micro-batch and 500ms
 * persist coalescing): only the latest cumulative partial per key survives, so
 * envelope seq numbers are sparse BY DESIGN — a coalesced-away seq never appears
 * in snapshots or pushes. Seq continuity therefore cannot signal a lost event:
 * delivery is monotonic-accept (render immediately), and a push-side gap only
 * triggers one background full refetch to backfill genuinely lost events via
 * seq dedup. Re-entering the thread (fresh snapshot) remains the final safety
 * net for loss.
 *
 * The hook does not write any atom; where events land is up to the consumer.
 */
export function useAgentEventBus(threadId: string, options: UseAgentEventBusOptions): void {
  const onEventRef = useRef(options.onEvent)
  onEventRef.current = options.onEvent
  // Max delivered seq per thread, kept across thread switches so switching
  // back resumes with afterSeq instead of replaying the whole event log.
  const maxSeqByThreadRef = useRef<Record<string, number>>({})

  const { enabled } = options

  useEffect(() => {
    if (!enabled) return
    const maxSeqByThread = maxSeqByThreadRef.current
    // 去重用已投递集合而非单一水位：push 空洞事件先到会把水位推高，
    // 对账回填的更低 seq 会被水位误判为已投递而丢失。
    const delivered = new Set<number>()
    let maxSeq = maxSeqByThread[threadId] ?? 0
    let disposed = false
    let unlisten: (() => void) | null = null
    let refetching = false

    const deliver = (e: SdkEventEnvelope, source: AgentEventBusSource) => {
      if (delivered.has(e.seq)) return // already delivered (pull/push overlap)
      const gap = e.seq > maxSeq + 1
      delivered.add(e.seq)
      maxSeq = Math.max(maxSeq, e.seq)
      maxSeqByThread[threadId] = maxSeq
      onEventRef.current(e, source)
      // 仅 push 空洞触发对账：折叠产生的空洞快照里同样没有，补拉无害（seq 去重）；
      // 真丢的推送事件由此回填。snapshot 本身就是全量真相，无需对账。
      if (gap && source === 'push') void refetchAll()
    }

    const deliverSorted = (events: SdkEventEnvelope[], source: AgentEventBusSource) => {
      const sorted = [...events].sort((a, b) => a.seq - b.seq)
      for (const e of sorted) deliver(e, source)
    }

    const refetchAll = async () => {
      if (refetching || disposed) return
      refetching = true
      try {
        const result = await getAgentEvents(threadId)
        if (disposed) return
        // 对账结果按 snapshot 语义投递：只回填缺失事件（seq 去重吸收其余），
        // 不把历史事件按 push 语义置 streaming。
        deliverSorted(result.events, 'snapshot')
      } catch (error) {
        console.error(`[useAgentEventBus] full refetch failed: ${threadId}`, error)
      } finally {
        refetching = false
      }
    }

    const pull = async () => {
      try {
        const result = await getAgentEvents(threadId, maxSeqByThread[threadId])
        if (!disposed) deliverSorted(result.events, 'snapshot')
      } catch (error) {
        console.error(`[useAgentEventBus] snapshot pull failed: ${threadId}`, error)
      }
    }
    void pull()

    onAgentEvents((e) => {
      if (disposed || e.threadId !== threadId) return
      deliver(e, 'push')
    }).then((fn) => {
      if (disposed) fn()
      else unlisten = fn
    })

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [threadId, enabled])
}
