import { describe, expect, test } from 'bun:test'
import { copyMermaidCode, stripStylesheetImports } from './MermaidBlock'

describe('MermaidBlock', () => {
  test('delegates copy through the host callback', async () => {
    const copied: string[] = []

    await copyMermaidCode('flowchart LR\n  A --> B', async (code) => { copied.push(code) })

    expect(copied).toEqual(['flowchart LR\n  A --> B'])
  })

  test('removes stylesheet imports from rendered SVG', () => {
    const svg = `<svg><style>@import url('https://fonts.googleapis.com/css2?family=Inter'); text { fill: black; font-family: 'Inter', system-ui; }</style></svg>`

    expect(stripStylesheetImports(svg)).toBe("<svg><style> text { fill: black; font-family: 'Inter', system-ui; }</style></svg>")
  })
})
