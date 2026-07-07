import { describe, expect, test } from 'bun:test'
import { findModelMeta, formatContextWindow, formatPricing } from './model-meta'

describe('findModelMeta', () => {
  test('matches by exact model id', () => {
    const meta = findModelMeta('claude-sonnet-4-20250514')
    expect(meta).toBeDefined()
    expect(meta!.displayName).toBe('Claude Sonnet 4')
    expect(meta!.contextWindow).toBe(200_000)
  })

  test('matches by alias', () => {
    const meta = findModelMeta('claude-3-5-sonnet')
    expect(meta).toBeDefined()
    expect(meta!.displayName).toBe('Claude Sonnet 4')
  })

  test('returns undefined for unknown model', () => {
    expect(findModelMeta('unknown-model-xyz')).toBeUndefined()
  })

  test('returns pricing when available', () => {
    const meta = findModelMeta('claude-sonnet-4-20250514')
    expect(meta!.pricing).toEqual({ input: 3, output: 15 })
  })

  test('returns capabilities correctly', () => {
    const meta = findModelMeta('claude-sonnet-4-20250514')
    expect(meta!.capabilities).toEqual({
      vision: true,
      toolUse: true,
      reasoning: true,
    })
  })

  test('matches OpenAI models', () => {
    const meta = findModelMeta('gpt-4o')
    expect(meta).toBeDefined()
    expect(meta!.displayName).toBe('GPT-4o')
    expect(meta!.contextWindow).toBe(128_000)
  })

  test('matches Gemini models', () => {
    const meta = findModelMeta('gemini-2.5-pro')
    expect(meta).toBeDefined()
    expect(meta!.displayName).toBe('Gemini 2.5 Pro')
    expect(meta!.contextWindow).toBe(1_000_000)
  })

  test('case-insensitive matching', () => {
    const meta = findModelMeta('CLAUDE-SONNET-4-20250514')
    expect(meta).toBeDefined()
    expect(meta!.displayName).toBe('Claude Sonnet 4')
  })

  test('prefix matching', () => {
    const meta = findModelMeta('claude-sonnet-4')
    expect(meta).toBeDefined()
    expect(meta!.displayName).toBe('Claude Sonnet 4')
  })

  test('claude-sonnet-4-5 contextWindow 匹配官方 spec（200K，非 models.dev 高估值）', () => {
    const meta = findModelMeta('claude-sonnet-4-5')
    expect(meta).toBeDefined()
    expect(meta!.contextWindow).toBe(200_000)
    expect(meta!.displayName).toBe('Claude Sonnet 4.5')
  })
})

describe('formatContextWindow', () => {
  test('formats thousands as K', () => {
    expect(formatContextWindow(128_000)).toBe('128K')
  })

  test('formats millions as M', () => {
    expect(formatContextWindow(1_000_000)).toBe('1M')
  })

  test('formats 200K', () => {
    expect(formatContextWindow(200_000)).toBe('200K')
  })
})

describe('formatPricing', () => {
  test('formats pricing as $input/$output', () => {
    expect(formatPricing({ input: 3, output: 15 })).toBe('$3/$15')
  })

  test('formats decimal pricing', () => {
    expect(formatPricing({ input: 0.8, output: 4 })).toBe('$0.8/$4')
  })
})
