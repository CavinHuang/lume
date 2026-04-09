import test from 'node:test'
import assert from 'node:assert/strict'

const { OpenAIProvider } = await import('../dist/providers/openai.js')

test('openai provider emits text deltas before final response', async () => {
  const encoder = new TextEncoder()
  const frames = [
    'data: {"choices":[{"index":0,"delta":{"content":"Hel"},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ]

  const realFetch = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          for (const frame of frames) {
            controller.enqueue(encoder.encode(frame))
          }
          controller.close()
        },
      }),
      {
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
        },
      },
    )

  try {
    const provider = new OpenAIProvider({
      apiKey: 'test-key',
      baseURL: 'https://example.com/v1',
    })

    const stream = provider.createMessageStream({
      model: 'gpt-test',
      maxTokens: 128,
      system: '',
      messages: [{ role: 'user', content: 'say hello' }],
    })

    const deltas = []
    let finalResponse = null

    while (true) {
      const next = await stream.next()
      if (next.done) {
        finalResponse = next.value
        break
      }
      deltas.push(next.value)
    }

    assert.deepEqual(deltas, [
      { type: 'text_delta', text: 'Hel' },
      { type: 'text_delta', text: 'lo' },
    ])
    assert.ok(finalResponse)
    assert.deepEqual(finalResponse.content, [{ type: 'text', text: 'Hello' }])
    assert.equal(finalResponse.stopReason, 'end_turn')
  } finally {
    globalThis.fetch = realFetch
  }
})
