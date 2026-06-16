import { describe, expect, test } from 'bun:test'
import type { RuntimeAssistantBlock } from './runtime-message-view'
import { groupAssistantBlocksForMinimal } from './minimal-assistant-grouping'

const text = (id: string): RuntimeAssistantBlock => ({ type: 'text', id, text: `t-${id}` })
const tool = (id: string): RuntimeAssistantBlock => ({
  type: 'tool_call',
  id,
  toolCall: { id, toolName: 'Bash', input: {}, status: 'completed' },
})
const think = (id: string): RuntimeAssistantBlock => ({ type: 'thinking', id, text: `k-${id}` })
const plan = (id: string): RuntimeAssistantBlock => ({
  type: 'plan_preview',
  id,
  preview: { contractId: id, title: 'p', summary: 's', markdown: 'm', stepCount: 1 },
})

describe('groupAssistantBlocksForMinimal', () => {
  test('[text] → 1 inline segment, no process', () => {
    const result = groupAssistantBlocksForMinimal([text('1')])
    expect(result).toHaveLength(1)
    expect(result.map((s) => s.kind)).toEqual(['inline'])
    expect(result[0].kind).toBe('inline')
  })

  test('[tool_call] → 1 process segment (1 block)', () => {
    const result = groupAssistantBlocksForMinimal([tool('1')])
    expect(result).toHaveLength(1)
    expect(result.map((s) => s.kind)).toEqual(['process'])
    expect(result[0].kind).toBe('process')
    expect(result[0].blocks.length).toBe(1)
  })

  test('[text, tool_call, text] → inline, process(1), inline', () => {
    const result = groupAssistantBlocksForMinimal([text('1'), tool('2'), text('3')])
    expect(result.map((s) => s.kind)).toEqual(['inline', 'process', 'inline'])
    if (result[1].kind === 'process') {
      expect(result[1].blocks.length).toBe(1)
    }
  })

  test('[tool_call, tool_call, text, tool_call] → process(2), inline, process(1)', () => {
    const result = groupAssistantBlocksForMinimal([tool('1'), tool('2'), text('3'), tool('4')])
    expect(result.map((s) => s.kind)).toEqual(['process', 'inline', 'process'])
    if (result[0].kind === 'process') {
      expect(result[0].blocks.length).toBe(2)
    }
    if (result[2].kind === 'process') {
      expect(result[2].blocks.length).toBe(1)
    }
  })

  test('[plan_preview, tool_call] → inline(plan_preview), process(1)', () => {
    const result = groupAssistantBlocksForMinimal([plan('1'), tool('2')])
    expect(result.map((s) => s.kind)).toEqual(['inline', 'process'])
    if (result[1].kind === 'process') {
      expect(result[1].blocks.length).toBe(1)
    }
  })

  test('thinking merges into the same process segment as adjacent tool_call', () => {
    const result = groupAssistantBlocksForMinimal([think('1'), tool('2'), text('3')])
    expect(result.map((s) => s.kind)).toEqual(['process', 'inline'])
    if (result[0].kind === 'process') {
      expect(result[0].blocks.length).toBe(2)
    }
  })

  test('empty input returns no segments', () => {
    const result = groupAssistantBlocksForMinimal([])
    expect(result).toEqual([])
  })
})
