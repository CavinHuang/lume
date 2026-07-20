import { describe, expect, test } from 'bun:test'
import { getInfographicCodeFromPreNode, isInfographicPreStreaming } from './markdown-infographic'

function preNode(language: string, code: string, state?: string) {
  return {
    name: 'pre',
    children: [{
      name: 'code',
      attribs: { class: `language-${language}`, ...(state ? { 'data-state': state } : {}) },
      children: [{ type: 'text', data: code }],
    }],
  }
}

describe('markdown infographic fence', () => {
  test('recognizes infographic fences case-insensitively', () => {
    expect(getInfographicCodeFromPreNode(preNode('Infographic', 'infographic list-grid-badge-card\n')))
      .toBe('infographic list-grid-badge-card')
  })

  test('leaves ordinary code fences untouched', () => {
    expect(getInfographicCodeFromPreNode(preNode('typescript', 'const value = 1'))).toBeNull()
  })

  test('reads streaming state from the code node', () => {
    expect(isInfographicPreStreaming(preNode('infographic', 'data', 'loading'))).toBeTrue()
    expect(isInfographicPreStreaming(preNode('infographic', 'data'))).toBeFalse()
  })
})
