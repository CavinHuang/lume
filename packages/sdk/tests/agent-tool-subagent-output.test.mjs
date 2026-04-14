import test from 'node:test'
import assert from 'node:assert/strict'

const {
  summarizeSubagentAssistantEvent,
  finalizeSubagentOutput,
} = await import('../src/tools/subagent-output.ts')

test('summarizeSubagentAssistantEvent accumulates multiple text blocks', () => {
  const summary = summarizeSubagentAssistantEvent([
    { type: 'text', text: '第一段' },
    { type: 'text', text: '第二段' },
  ])

  assert.equal(summary.textOutput, '第一段\n\n第二段')
  assert.equal(summary.lastAssistantMessage, '第二段')
  assert.deepEqual(summary.toolCalls, [])
  assert.equal(summary.toolUseCount, 0)
})

test('finalizeSubagentOutput falls back to tool summary when there is no text output', () => {
  const finalized = finalizeSubagentOutput('', ['Glob', 'Read'])

  assert.match(finalized.output, /子 Agent 已完成，未返回最终文本总结/)
  assert.match(finalized.output, /Glob、Read/)
  assert.match(finalized.output, /\[Tools used: Glob, Read\]/)
  assert.equal(finalized.lastAssistantMessage, '子 Agent 已完成，未返回最终文本总结。已执行工具：Glob、Read')
})

test('finalizeSubagentOutput preserves plain fallback when there is no text and no tools', () => {
  const finalized = finalizeSubagentOutput('', [])

  assert.equal(finalized.output, '(Subagent completed with no text output)')
  assert.equal(finalized.lastAssistantMessage, undefined)
})
