import test from 'node:test'
import assert from 'node:assert/strict'

const sdk = await import('../dist/index.js')

test('structured output exhaustion returns error_max_structured_output_retries', async () => {
  let calls = 0
  const provider = {
    apiType: 'anthropic-messages',
    async createMessage() {
      calls += 1
      return {
        content: [{ type: 'text', text: `not json ${calls}` }],
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
    maxTurns: 5,
    maxTokens: 256,
    canUseTool: async () => ({ behavior: 'allow' }),
    includePartialMessages: false,
    permissionMode: 'default',
    outputFormat: {
      type: 'json_schema',
      schema: {
        type: 'object',
        properties: {
          answer: { type: 'string' },
        },
        required: ['answer'],
      },
    },
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

  const result = events.find((event) => event.type === 'result')
  assert.ok(result)
  assert.equal(result.subtype, 'error_max_structured_output_retries')
  assert.equal(result.is_error, true)
  assert.match(result.errors[0], /Structured output validation failed/i)
})
