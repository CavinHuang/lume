import { useEffect, useRef } from 'react'
import type { SdkEventEnvelope } from '@lume/shared'
import { getAgentEvents, onAgentEvents } from '@/lib/desktop-api/agent'

/** snapshot = 首次挂载/线程切回的初始拉取回放;push = 实时推送与空洞补拉。 */
export type AgentEventBusSource = 'snapshot' | 'push'

export interface UseAgentEventBusOptions {
  enabled: boolean
  onEvent: (e: SdkEventEnvelope, source: AgentEventBusSource) => void
}

/**
 * Consume the sidecar lifecycle event bus for one thread.
 *
 * On mount: pull a snapshot via getAgentEvents (with afterSeq when this thread
 * was seen before), then subscribe to pushes. Push events are delivered in seq
 * order only — duplicates are dropped and a gap triggers a full refetch whose
 * result is merged back through the same seq-deduping deliver path.
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
    let localMax = maxSeqByThread[threadId] ?? 0
    let disposed = false
    let unlisten: (() => void) | null = null
    let refetching = false
    // Push events that arrived ahead of their predecessors and are not covered
    // by the refetch result yet; replayed after every refetch.
    let pending: SdkEventEnvelope[] = []

    const deliver = (e: SdkEventEnvelope, source: AgentEventBusSource, fromPending = false) => {
      if (e.seq <= localMax) return // already delivered (pull/push overlap)
      if (e.seq > localMax + 1) {
        if (!fromPending) {
          pending.push(e)
          void refetchAll()
        }
        return
      }
      localMax = e.seq
      maxSeqByThread[threadId] = e.seq
      onEventRef.current(e, source)
    }

    const deliverSorted = (events: SdkEventEnvelope[], source: AgentEventBusSource, fromPending = false) => {
      const sorted = [...events].sort((a, b) => a.seq - b.seq)
      for (const e of sorted) deliver(e, source, fromPending)
    }

    const refetchAll = async () => {
      if (refetching || disposed) return
      refetching = true
      try {
        const result = await getAgentEvents(threadId)
        if (disposed) return
        deliverSorted(result.events, 'push')
        deliverSorted(pending, 'push', true)
        pending = pending.filter((e) => e.seq > localMax)
      } catch (error) {
        console.error(`[useAgentEventBus] full refetch failed: ${threadId}`, error)
      } finally {
        refetching = false
      }
    }

    const pull = async () => {
      try {
        const result = await getAgentEvents(threadId, maxSeqByThread[threadId])
        if (disposed) return
        deliverSorted(result.events, 'snapshot')
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
