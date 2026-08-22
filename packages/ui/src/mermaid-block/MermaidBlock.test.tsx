import { describe, expect, test } from 'bun:test'
import {
  copyMermaidCode,
  copyMermaidImage,
  getResizedMermaidHeight,
  stripStylesheetImports,
} from './MermaidBlock'

describe('MermaidBlock', () => {
  test('delegates copy through the host callback', async () => {
    const copied: string[] = []

    await copyMermaidCode('flowchart LR\n  A --> B', async (code) => { copied.push(code) })

    expect(copied).toEqual(['flowchart LR\n  A --> B'])
  })

  test('delegates image copy through the host callback', async () => {
    const copied: string[] = []

    await copyMermaidImage('<svg />', async (svg) => { copied.push(svg) })

    expect(copied).toEqual(['<svg />'])
  })

  test('resizes diagram height within supported bounds', () => {
    expect(getResizedMermaidHeight(400, 80)).toBe(480)
    expect(getResizedMermaidHeight(300, -200)).toBe(220)
    expect(getResizedMermaidHeight(1100, 300)).toBe(1200)
  })

  test('removes stylesheet imports from rendered SVG', () => {
    const svg = `<svg><style>@import url('https://fonts.googleapis.com/css2?family=Inter'); text { fill: black; font-family: 'Inter', system-ui; }</style></svg>`

    expect(stripStylesheetImports(svg)).toBe("<svg><style> text { fill: black; font-family: 'Inter', system-ui; }</style></svg>")
  })

  test('removes string-form stylesheet imports (CSS allows @import "foo.css"; without url())', () => {
    const svg = `<svg><style>@import "https://evil.example/hook.css"; @import 'https://evil.example/2.css'; text { fill: black; }</style></svg>`

    expect(stripStylesheetImports(svg)).toBe('<svg><style>  text { fill: black; }</style></svg>')
  })

  test('keeps ordinary CSS and label text containing @import-like words', () => {
    const svg = `<svg><style> text { fill: black; font-family: 'Inter'; }</style><text>user@important.com</text></svg>`

    expect(stripStylesheetImports(svg)).toBe(svg)
  })
})
