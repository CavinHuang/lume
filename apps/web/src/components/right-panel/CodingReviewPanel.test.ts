import { describe, expect, test } from 'bun:test'
import { buildDiffFileTree, buildDiffHighlightSlice, buildFullDiffSections, buildSplitDiffRows, estimateDiffBodyHeight } from './CodingReviewPanel'

describe('CodingReviewPanel full diff', () => {
  test('estimates a bounded placeholder height without preparing the full file', () => {
    const lines = [
      { type: 'context' as const, oldLine: 10, newLine: 10, text: 'before' },
      { type: 'removed' as const, oldLine: 11, text: 'old' },
      { type: 'added' as const, newLine: 11, text: 'new' },
      { type: 'context' as const, oldLine: 80, newLine: 80, text: 'after' },
    ]

    expect(estimateDiffBodyHeight({ lines })).toBe(136)
    expect(estimateDiffBodyHeight({ lines: Array.from({ length: 1000 }, (_, index) => ({
      type: 'added' as const,
      newLine: index + 1,
      text: `line ${index + 1}`,
    })) })).toBe(900)
  })

  test('collapses leading and trailing unchanged file ranges around a hunk', () => {
    const oldLines = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`)
    const newLines = [...oldLines]
    newLines[42] = 'changed line 43'

    const sections = buildFullDiffSections([
      { type: 'context', oldLine: 40, newLine: 40, text: 'line 40' },
      { type: 'context', oldLine: 41, newLine: 41, text: 'line 41' },
      { type: 'context', oldLine: 42, newLine: 42, text: 'line 42' },
      { type: 'removed', oldLine: 43, text: 'line 43' },
      { type: 'added', newLine: 43, text: 'changed line 43' },
      { type: 'context', oldLine: 44, newLine: 44, text: 'line 44' },
      { type: 'context', oldLine: 45, newLine: 45, text: 'line 45' },
      { type: 'context', oldLine: 46, newLine: 46, text: 'line 46' },
    ], `${oldLines.join('\n')}\n`, `${newLines.join('\n')}\n`)

    expect(sections.filter((section) => section.type === 'collapsed').map((section) => section.lines.length))
      .toEqual([39, 54])
    expect(sections.flatMap((section) => section.type === 'lines' ? section.lines : [])
      .filter((line) => line.type !== 'context')).toEqual([
        { type: 'removed', oldLine: 43, text: 'line 43' },
        { type: 'added', newLine: 43, text: 'changed line 43' },
      ])
  })
})

describe('CodingReviewPanel split diff', () => {
  test('aligns removed and added blocks while preserving context on both sides', () => {
    expect(buildSplitDiffRows([
      { type: 'context', oldLine: 1, newLine: 1, text: 'same' },
      { type: 'removed', oldLine: 2, text: 'old a' },
      { type: 'removed', oldLine: 3, text: 'old b' },
      { type: 'added', newLine: 2, text: 'new a' },
      { type: 'context', oldLine: 4, newLine: 3, text: 'same again' },
    ])).toEqual([
      {
        oldLine: { type: 'context', oldLine: 1, newLine: 1, text: 'same' },
        newLine: { type: 'context', oldLine: 1, newLine: 1, text: 'same' },
      },
      {
        oldLine: { type: 'removed', oldLine: 2, text: 'old a' },
        newLine: { type: 'added', newLine: 2, text: 'new a' },
      },
      {
        oldLine: { type: 'removed', oldLine: 3, text: 'old b' },
        newLine: undefined,
      },
      {
        oldLine: { type: 'context', oldLine: 4, newLine: 3, text: 'same again' },
        newLine: { type: 'context', oldLine: 4, newLine: 3, text: 'same again' },
      },
    ])
  })
})

describe('CodingReviewPanel diff file tree', () => {
  test('compacts single-child folder chains and keeps files sorted', () => {
    expect(buildDiffFileTree([
      'apps/web/src/B.ts',
      'apps/web/src/A.ts',
    ])).toEqual([
      {
        type: 'folder',
        name: 'apps/web/src',
        path: 'apps/web/src',
        children: [
          { type: 'file', name: 'A.ts', path: 'apps/web/src/A.ts' },
          { type: 'file', name: 'B.ts', path: 'apps/web/src/B.ts' },
        ],
      },
    ])
  })
})

describe('CodingReviewPanel visible diff highlighting', () => {
  test('builds separate old and new snippets from rendered rows only', () => {
    const lines = [
      { type: 'context' as const, oldLine: 10, newLine: 10, text: 'same' },
      { type: 'removed' as const, oldLine: 11, text: 'old' },
      { type: 'added' as const, newLine: 11, text: 'new' },
    ]

    expect(buildDiffHighlightSlice(lines, 'old')).toEqual({
      code: 'same\nold',
      lineNumbers: [10, 11],
    })
    expect(buildDiffHighlightSlice(lines, 'new')).toEqual({
      code: 'same\nnew',
      lineNumbers: [10, 11],
    })
  })
})
