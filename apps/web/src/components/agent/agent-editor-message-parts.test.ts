import { describe, expect, test } from 'bun:test'
import { serializeAgentEditorMessage } from './agent-editor-message-parts'

describe('serializeAgentEditorMessage', () => {
  test('keeps visible canonical URIs aligned with structured reference parts', () => {
    const result = serializeAgentEditorMessage({
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Use ' },
          { type: 'capabilityMention', attrs: { uri: 'lume-skill://review', occurrenceId: 'ref-1' } },
          { type: 'text', text: ' now' },
        ],
      }],
    })

    expect(result.userMessage).toBe('Use lume-skill://review now')
    expect(result.messageParts).toEqual([
      { type: 'text', text: 'Use ' },
      { type: 'capability_ref', occurrenceId: 'ref-1', uri: 'lume-skill://review' },
      { type: 'text', text: ' now' },
    ])
  })

  test('does not authorize canonical URI text nodes', () => {
    const result = serializeAgentEditorMessage({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'log: lume-plugin://demo' }] }],
    })
    expect(result.messageParts).toEqual([{ type: 'text', text: 'log: lume-plugin://demo' }])
  })
})
