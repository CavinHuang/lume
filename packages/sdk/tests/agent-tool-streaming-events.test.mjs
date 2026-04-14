import test from 'node:test'
import assert from 'node:assert/strict'

const {
  annotateSubagentStreamingEvent,
} = await import('../src/tools/agent-tool-events.ts')

test('annotateSubagentStreamingEvent tags assistant events with subagent_run_id and parent session', () => {
  const tagged = annotateSubagentStreamingEvent({
    type: 'assistant',
    session_id: 'child-session',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'hello' }],
    },
  }, {
    subagentRunId: 'run-1',
    parentSessionId: 'parent-session',
  })

  assert.equal(tagged?.subagent_run_id, 'run-1')
  assert.equal(tagged?.session_id, 'parent-session')
  assert.equal(tagged?.type, 'assistant')
})

test('annotateSubagentStreamingEvent ignores non-streaming result messages', () => {
  const tagged = annotateSubagentStreamingEvent({
    type: 'result',
    subtype: 'success',
    session_id: 'child-session',
  }, {
    subagentRunId: 'run-1',
    parentSessionId: 'parent-session',
  })

  assert.equal(tagged, null)
})
