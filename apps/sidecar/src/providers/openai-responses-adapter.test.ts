import { describe, test, expect } from 'bun:test'
import { OpenAIResponsesAdapter } from './openai-responses-adapter'

describe('OpenAIResponsesAdapter', () => {
  const adapter = new OpenAIResponsesAdapter()

  const mockInput = {
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'test-key',
    modelId: 'gpt-4o',
    history: [],
    userMessage: 'Hello',
    systemMessage: 'You are helpful',
    attachments: [],
    readImageAttachments: () => [],
  }

  describe('buildStreamRequest', () => {
    test('should target /responses endpoint', () => {
      const request = adapter.buildStreamRequest(mockInput)
      expect(request.url).toBe('https://api.openai.com/v1/responses')
    })

    test('should use instructions field for system message', () => {
      const request = adapter.buildStreamRequest(mockInput)
      const body = JSON.parse(request.body)
      expect(body.instructions).toBe('You are helpful')
    })

    test('should use input array instead of messages', () => {
      const request = adapter.buildStreamRequest(mockInput)
      const body = JSON.parse(request.body)
      expect(body.input).toBeDefined()
      expect(body.messages).toBeUndefined()
    })

    test('should include Bearer auth header', () => {
      const request = adapter.buildStreamRequest(mockInput)
      expect(request.headers['Authorization']).toBe('Bearer test-key')
    })
  })

  describe('parseSSELine', () => {
    test('should parse response.output_text.delta events', () => {
      const events = adapter.parseSSELine(JSON.stringify({
        type: 'response.output_text.delta',
        delta: 'Hello',
        output_index: 0,
        content_index: 0,
      }))

      expect(events).toEqual([
        { type: 'chunk', delta: 'Hello' },
      ])
    })

    test('should parse response.function_call_arguments.delta events', () => {
      const events = adapter.parseSSELine(JSON.stringify({
        type: 'response.function_call_arguments.delta',
        delta: '{"location":',
        output_index: 1,
      }))

      expect(events).toEqual([
        { type: 'tool_call_delta', toolCallId: 'fc_1', argumentsDelta: '{"location":' },
      ])
    })

    test('should parse response.output_item.added for function calls', () => {
      const events = adapter.parseSSELine(JSON.stringify({
        type: 'response.output_item.added',
        output_index: 1,
        item: {
          type: 'function_call',
          id: 'fc_001',
          call_id: 'call_001',
          name: 'get_weather',
          arguments: '',
          status: 'in_progress',
        },
      }))

      expect(events).toEqual([
        { type: 'tool_call_start', toolCallId: 'call_001', toolName: 'get_weather' },
      ])
    })

    test('should parse response.completed event', () => {
      const events = adapter.parseSSELine(JSON.stringify({
        type: 'response.completed',
        response: {
          output: [
            { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done' }] },
          ],
        },
      }))

      expect(events).toEqual([
        { type: 'done', stopReason: 'end_turn' },
      ])
    })

    test('should return empty array for unknown event types', () => {
      const events = adapter.parseSSELine(JSON.stringify({
        type: 'response.created',
        response: { id: 'resp_123' },
      }))

      expect(events).toEqual([])
    })

    test('should handle malformed JSON gracefully', () => {
      const events = adapter.parseSSELine('not valid json')
      expect(events).toEqual([])
    })
  })

  describe('buildTitleRequest', () => {
    test('should target /responses endpoint', () => {
      const request = adapter.buildTitleRequest({
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'key',
        modelId: 'gpt-4o-mini',
        prompt: 'Generate a title',
      })

      expect(request.url).toBe('https://api.openai.com/v1/responses')
      const body = JSON.parse(request.body)
      expect(body.input[0].content[0].text).toContain('Generate a title')
    })
  })

  describe('parseTitleResponse', () => {
    test('should extract text from output', () => {
      const title = adapter.parseTitleResponse({
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'My Chat Title' }],
          },
        ],
      })

      expect(title).toBe('My Chat Title')
    })

    test('should return null for empty output', () => {
      expect(adapter.parseTitleResponse({ output: [] })).toBeNull()
      expect(adapter.parseTitleResponse({})).toBeNull()
    })
  })
})
