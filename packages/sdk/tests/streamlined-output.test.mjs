import test from 'node:test'
import assert from 'node:assert/strict'

const sdk = await import('../dist/index.js')

test('query engine emits streamlined output events when enabled', async () => {
  const provider = {
    apiType: 'anthropic-messages',
    async createMessage() {
      return {
        content: [
          { type: 'text', text: 'Reading and updating the target file.' },
          { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'a.ts' } },
        ],
        stopReason: 'tool_use',
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
      outputStyle: 'streamlined',
      claudeCodeVersion: 'test',
      apiKeySource: 'configured',
    },
  })

  const events = []
  for await (const event of engine.submitMessage('hello')) {
    events.push(event)
  }

  const streamlinedText = events.find((event) => event.type === 'streamlined_text')
  const streamlinedToolSummary = events.find(
    (event) => event.type === 'streamlined_tool_use_summary',
  )

  assert.ok(streamlinedText)
  assert.match(streamlinedText.text, /Reading and updating/i)
  assert.ok(streamlinedToolSummary)
  assert.match(streamlinedToolSummary.tool_summary, /Read/)
})
