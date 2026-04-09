import test from 'node:test'
import assert from 'node:assert/strict'

const sdk = await import('../dist/index.js')

test('query engine emits thinking stream_event before final assistant message', async () => {
  const provider = {
    apiType: 'anthropic-messages',
    async *createMessageStream() {
      yield { type: 'thinking_delta', thinking: '先分析上下文' }
      yield { type: 'text_delta', text: '最终答案' }
      return {
        content: [
          { type: 'thinking', thinking: '先分析上下文' },
          { type: 'text', text: '最终答案' },
        ],
        stopReason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      }
    },
    async createMessage() {
      throw new Error('should not be called when createMessageStream is available')
    },
  }

  const engine = new sdk.QueryEngine({
    cwd: process.cwd(),
    model: 'claude-sonnet-4-6',
    provider,
    tools: [],
    maxTurns: 1,
    maxTokens: 256,
    canUseTool: async () => ({ behavior: 'allow' }),
    includePartialMessages: true,
    permissionMode: 'default',
    initialization: {
      slashCommands: [],
      skills: [],
      plugins: [],
      outputStyle: 'text',
      claudeCodeVersion: 'test',
      apiKeySource: 'configured',
    },
  })

  const events = []
  for await (const event of engine.submitMessage('hello')) {
    events.push(event)
  }

  const thinkingEvent = events.find(
    (event) =>
      event.type === 'stream_event' &&
      event.event &&
      event.event.type === 'content_block_delta' &&
      event.event.delta &&
      event.event.delta.type === 'thinking_delta',
  )
  const finalAssistant = events.find((event) => event.type === 'assistant')

  assert.ok(thinkingEvent)
  assert.ok(finalAssistant)
  assert.equal(finalAssistant.message.content[0].type, 'thinking')
  assert.equal(finalAssistant.message.content[1].type, 'text')
})
