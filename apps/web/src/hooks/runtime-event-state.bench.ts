import { appendRuntimeEvent } from './runtime-event-state'
import type { LumeRuntimeEvent } from '@lume/shared'

function delta(seq: number, text: string): LumeRuntimeEvent {
  return {
    type: 'assistant.delta', id: `d${seq}`, threadId: 't1',
    createdAt: `2026-06-21T00:00:00.${String(seq).padStart(3, '0')}Z`,
    sequence: seq, runId: 'run-1', messageId: 'msg-1', delta: text,
  } as LumeRuntimeEvent
}

const N = 1000
let state: any = {}
const start = performance.now()
for (let i = 1; i <= N; i++) state = appendRuntimeEvent(state, delta(i, `t${i}`))
const elapsed = performance.now() - start
console.log(`appendRuntimeEvent x${N}: ${elapsed.toFixed(1)}ms, final events=${state.t1.events.length}`)
