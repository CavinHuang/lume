import test from 'node:test'
import assert from 'node:assert/strict'

const sdk = await import('../dist/index.js')

test('query engine emits api_retry before succeeding on retryable error', async () => {
  let calls = 0
  const provider = {
    apiType: 'anthropic-messages',
    async createMessage() {
      calls += 1
      if (calls === 1) {
        const error = new Error('rate limited')
        error.status = 429
        throw error
      }
      return {
        content: [{ type: 'text', text: 'done' }],
        stopReason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      }
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
    includePartialMessages: false,
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

  const messages = []
  for await (const event of engine.submitMessage('hello')) {
    messages.push(event)
  }

  const retryEvent = messages.find((event) => event.type === 'system' && event.subtype === 'api_retry')
  assert.ok(retryEvent)
  assert.equal(retryEvent.error, 'rate_limit')
  assert.equal(calls, 2)
})
