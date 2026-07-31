import { describe, expect, test } from 'bun:test'
import { resolveThemes } from '@pierre/diffs'
import { createPierreFileDiff } from './PierreDiffView'
import { LUME_DIFF_THEMES, registerLumeDiffThemes } from './pierre-theme'

describe('Lume Pierre themes', () => {
  test('registers both themes before the worker pool resolves them', async () => {
    registerLumeDiffThemes()

    const themes = await resolveThemes([
      LUME_DIFF_THEMES.light,
      LUME_DIFF_THEMES.dark,
    ])

    expect(themes.map(theme => theme.name)).toEqual([
      LUME_DIFF_THEMES.light,
      LUME_DIFF_THEMES.dark,
    ])
  })
})

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
