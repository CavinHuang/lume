import { describe, expect, test } from 'bun:test'
import { getMermaidCodeFromPreNode } from './markdown-mermaid'

function preNode(lang: string, code: string) {
  return {
    name: 'pre',
    children: [{
      name: 'code',
      attribs: { 'data-lang': lang },
      children: [{ type: 'text', data: code }],
    }],
  }
}

describe('getMermaidCodeFromPreNode', () => {
  test('recognizes Mermaid case-insensitively and ignores info string parameters', () => {
    expect(getMermaidCodeFromPreNode(preNode('MerMaid theme=neutral', 'flowchart LR\n  A --> B\n')))
      .toBe('flowchart LR\n  A --> B')
  })

  test('leaves ordinary fenced code to the normal pre renderer', () => {
    expect(getMermaidCodeFromPreNode(preNode('typescript', 'const answer = 42'))).toBeNull()
  })

  test('rejects malformed pre nodes without a code language', () => {
    expect(getMermaidCodeFromPreNode({ name: 'pre', children: [] })).toBeNull()
  })
})
