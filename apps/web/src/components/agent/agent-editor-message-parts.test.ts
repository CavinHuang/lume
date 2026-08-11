import { describe, expect, test } from 'bun:test'
import { remapAgentMessagePartsForEditedText, serializeAgentEditorMessage } from './agent-editor-message-parts'

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

  test('serializes Connector mentions as visible account text and structured refs', () => {
    const result = serializeAgentEditorMessage({
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Check ' },
          { type: 'linkConnectionMention', attrs: { schemaVersion: 1, service: 'gmail', connectionName: 'work', displayText: 'Gmail · user@example.com' } },
        ],
      }],
    })
    expect(result.userMessage).toBe('Check @Gmail · user@example.com')
    expect(result.messageParts).toEqual([
      { type: 'text', text: 'Check ' },
      { type: 'link_connection_ref', schemaVersion: 1, service: 'gmail', connectionName: 'work', displayText: 'Gmail · user@example.com' },
    ])
  })

  test('keeps Connector refs when editing and resending surrounding text', () => {
    const reference = { type: 'link_connection_ref' as const, schemaVersion: 1 as const, service: 'gmail', connectionName: 'work', displayText: 'Gmail · user@example.com' }
    expect(remapAgentMessagePartsForEditedText(
      [{ type: 'text', text: 'Check ' }, reference],
      'Please check @Gmail · user@example.com today',
    )).toEqual([
      { type: 'text', text: 'Please check ' },
      reference,
      { type: 'text', text: ' today' },
    ])
  })
})
