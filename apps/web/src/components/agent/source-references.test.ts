import { describe, expect, test } from 'vitest'
import { collectAssistantSources, extractToolCallSources } from './source-references'

describe('source references', () => {
  test('extracts actual WebSearch data payloads and deduplicates URLs', () => {
    const result = extractToolCallSources({
      id: 'search-1',
      toolName: 'web_search',
      input: { query: 'lume' },
      status: 'completed',
      output: JSON.stringify({ data: [
        { title: 'Lume', url: 'https://example.com/page#intro' },
        { name: 'Duplicate', link: 'https://example.com/page/' },
      ] }),
    })

    expect(result.sources).toHaveLength(1)
    expect(result.sources[0]).toMatchObject({ title: 'Lume', domain: 'example.com' })
  })

  test('normalizes WebFetch bare hostnames and blocks unsafe query values from the link', () => {
    const result = extractToolCallSources({
      id: 'fetch-1',
      toolName: 'WebFetch',
      input: { url: 'example.com/docs?api_key=secret&lang=zh' },
      status: 'completed',
      output: 'content',
    })

    expect(result.sources[0]?.url).toBe('https://example.com/docs?lang=zh')
    expect(result.sources[0]?.clickable).toBe(true)
  })

  test('excludes failed calls and does not make private links clickable', () => {
    const result = collectAssistantSources([
      { type: 'tool_call', id: 'failed', toolCall: { id: 'failed', toolName: 'WebFetch', input: { url: 'https://example.com' }, status: 'failed', isError: true } },
      { type: 'tool_call', id: 'local', toolCall: { id: 'local', toolName: 'WebFetch', input: { url: 'http://localhost:3000' }, status: 'completed' } },
    ])

    expect(result.sources).toHaveLength(1)
    expect(result.sources[0]?.clickable).toBe(false)
  })
})
