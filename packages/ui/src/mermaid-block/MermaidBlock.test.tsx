import { describe, expect, test } from 'bun:test'
import { copyMermaidCode } from './MermaidBlock'

describe('MermaidBlock', () => {
  test('delegates copy through the host callback', async () => {
    const copied: string[] = []

    await copyMermaidCode('flowchart LR\n  A --> B', async (code) => { copied.push(code) })

    expect(copied).toEqual(['flowchart LR\n  A --> B'])
  })
})
