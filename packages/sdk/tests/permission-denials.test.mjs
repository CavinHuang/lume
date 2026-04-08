import test from 'node:test'
import assert from 'node:assert/strict'

const sdk = await import('../dist/index.js')

test('result message uses official permission_denials shape', async () => {
  const provider = {
    apiType: 'anthropic-messages',
    async createMessage() {
      return {
        content: [
          {
            type: 'tool_use',
            id: 'tool-deny-1',
            name: 'Write',
            input: { file_path: 'out.txt', content: 'hello' },
          },
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
    tools: [
      {
        name: 'Write',
        description: 'write file',
        inputSchema: { type: 'object', properties: {} },
        call: async () => ({ type: 'tool_result', tool_use_id: '', content: '' }),
        isReadOnly: () => false,
      },
    ],
    maxTurns: 1,
    maxTokens: 256,
    canUseTool: async () => ({ behavior: 'deny', message: 'blocked' }),
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

  const result = events.find((event) => event.type === 'result')
  assert.ok(result)
  assert.deepEqual(result.permission_denials, [
    {
      tool_name: 'Write',
      tool_use_id: 'tool-deny-1',
      tool_input: { file_path: 'out.txt', content: 'hello' },
    },
  ])
})
