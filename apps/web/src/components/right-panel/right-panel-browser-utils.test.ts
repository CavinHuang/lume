import { describe, expect, test } from 'bun:test'
import { getDefaultLocalBrowserServices, normalizeRightPanelBrowserUrl } from './right-panel-browser-utils'

describe('right-panel browser utils', () => {
  test('normalizes localhost-style addresses to http and external hosts to https', () => {
    expect(normalizeRightPanelBrowserUrl('localhost:3000')).toBe('http://localhost:3000')
    expect(normalizeRightPanelBrowserUrl('127.0.0.1:5173')).toBe('http://127.0.0.1:5173')
    expect(normalizeRightPanelBrowserUrl('example.com')).toBe('https://example.com')
    expect(normalizeRightPanelBrowserUrl('https://openai.com')).toBe('https://openai.com')
  })

  test('provides the default local Lume service card', () => {
    expect(getDefaultLocalBrowserServices()).toContainEqual({
      title: 'Lume',
      url: 'http://localhost:3000',
    })
  })
})
