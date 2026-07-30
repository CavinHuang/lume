import { describe, expect, test } from 'bun:test'
import { createPierreFileDiff } from './PierreDiffView'

describe('createPierreFileDiff', () => {
  test('can omit whitespace-only changes while keeping real edits', () => {
    const whitespaceOnly = createPierreFileDiff({
      oldContent: 'const value = 1\n',
      newContent: '  const value = 1\n',
      filePath: 'example.ts',
      ignoreWhitespace: true,
    })
    const realEdit = createPierreFileDiff({
      oldContent: 'const value = 1\n',
      newContent: 'const value = 2\n',
      filePath: 'example.ts',
      ignoreWhitespace: true,
    })

    expect(whitespaceOnly[0]?.hunks).toHaveLength(0)
    expect(realEdit[0]?.hunks.length).toBeGreaterThan(0)
  })
})
