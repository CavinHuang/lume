import test from 'node:test'
import assert from 'node:assert/strict'

const { OpenAIProvider } = await import('../dist/providers/openai.js')

test('openai-compatible provider emits thinking deltas from reasoning_content and preserves final thinking block', async () => {
  const encoder = new TextEncoder()
  const frames = [
    'data: {"choices":[{"index":0,"delta":{"reasoning_content":"先分析问题"},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"content":"最终答案"},"finish_reason":"stop"}]}\n\n',
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
      model: 'glm-4.5',
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
      { type: 'thinking_delta', thinking: '先分析问题' },
      { type: 'text_delta', text: '最终答案' },
    ])
    assert.ok(finalResponse)
    assert.deepEqual(finalResponse.content, [
      { type: 'thinking', thinking: '先分析问题' },
      { type: 'text', text: '最终答案' },
    ])
  } finally {
    globalThis.fetch = realFetch
  }
})
