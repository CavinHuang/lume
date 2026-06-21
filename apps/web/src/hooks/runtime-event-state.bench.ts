/**
 * 手动基准脚本（非自动测试）：通过 `bun apps/web/src/hooks/runtime-event-state.bench.ts` 运行，
 * 不会被 `bun test` 自动收集，修改 `appendRuntimeEvent` 后请手动复测以免该脚本静默腐化。
 */
import { appendRuntimeEvent, type RuntimeEventState } from './runtime-event-state'
import type { LumeRuntimeEvent } from '@lume/shared'

function delta(seq: number, text: string): LumeRuntimeEvent {
  return {
    type: 'assistant.delta', id: `d${seq}`, threadId: 't1',
    createdAt: `2026-06-21T00:00:00.${String(seq).padStart(3, '0')}Z`,
    sequence: seq, runId: 'run-1', messageId: 'msg-1', delta: text,
  } as LumeRuntimeEvent
}

const N = 10000
const TRIALS = 3
let best = Infinity
for (let t = 1; t <= TRIALS; t++) {
  let state: RuntimeEventState = {}
  const start = performance.now()
  for (let i = 1; i <= N; i++) state = appendRuntimeEvent(state, delta(i, `t${i}`))
  const elapsed = performance.now() - start
  if (elapsed < best) best = elapsed
  if (t === TRIALS) {
    console.log(`appendRuntimeEvent x${N} (min of ${TRIALS}): ${best.toFixed(1)}ms, final events=${state.t1.events.length}`)
  }
}
