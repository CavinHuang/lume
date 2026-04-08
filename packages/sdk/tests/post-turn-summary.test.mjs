import test from 'node:test'
import assert from 'node:assert/strict'

const sdk = await import('../dist/index.js')

test('query engine emits post_turn_summary after assistant output', async () => {
  const provider = {
    apiType: 'anthropic-messages',
    async createMessage() {
      return {
        content: [{ type: 'text', text: 'Review the generated patch before merging.' }],
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

  const events = []
  for await (const event of engine.submitMessage('hello')) {
    events.push(event)
  }

  const assistantIndex = events.findIndex((event) => event.type === 'assistant')
  const summaryIndex = events.findIndex(
    (event) => event.type === 'system' && event.subtype === 'post_turn_summary',
  )
  assert.ok(assistantIndex !== -1)
  assert.ok(summaryIndex > assistantIndex)

  const summary = events[summaryIndex]
  assert.equal(summary.status_category, 'review_ready')
  assert.match(summary.description, /Review the generated patch/i)
})
