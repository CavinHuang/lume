import test from 'node:test'
import assert from 'node:assert/strict'

const sdk = await import('../src/index.ts')

test('OpenAIProvider accepts single content block objects without crashing', async () => {
  const provider = new sdk.OpenAIProvider({ apiKey: 'test-key', baseURL: 'https://example.invalid/v1' })
  const originalFetch = globalThis.fetch
  let capturedBody = null

  globalThis.fetch = async (_url, options) => {
    capturedBody = JSON.parse(String(options?.body ?? '{}'))
    return new Response(
      JSON.stringify({
        id: 'resp-1',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: 'ok',
          },
          finish_reason: 'stop',
        }],
        usage: {
          prompt_tokens: 1,
          completion_tokens: 1,
          total_tokens: 2,
        },
      }),
      {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      },
    )
  }

  try {
    const response = await provider.createMessage({
      system: '',
      model: 'gpt-4o-mini',
      maxTokens: 256,
      messages: [
        {
          role: 'user',
          content: { type: 'text', text: 'hello from single block' },
        },
        {
          role: 'assistant',
          content: { type: 'tool_use', id: 'call-1', name: 'Read', input: { path: 'README.md' } },
        },
      ],
    })

    assert.equal(response.stopReason, 'end_turn')
    assert.equal(capturedBody?.messages?.[0]?.role, 'user')
    assert.equal(capturedBody?.messages?.[0]?.content, 'hello from single block')
    assert.equal(capturedBody?.messages?.[1]?.role, 'assistant')
    assert.equal(capturedBody?.messages?.[1]?.tool_calls?.[0]?.function?.name, 'Read')
  } finally {
    globalThis.fetch = originalFetch
  }
})
