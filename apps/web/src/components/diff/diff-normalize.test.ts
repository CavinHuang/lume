import { describe, expect, test } from 'bun:test'
import { parsePatchFiles } from '@pierre/diffs'
import { normalizeDiffSnippet } from './diff-normalize'

describe('normalizeDiffSnippet', () => {
  test('keeps a complete multi-file git patch parseable by Pierre', () => {
    const patch = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/b.ts b/b.ts',
      '--- a/b.ts',
      '+++ b/b.ts',
      '@@ -1 +1 @@',
      '-before',
      '+after',
    ].join('\n')
    expect(parsePatchFiles(normalizeDiffSnippet(patch), undefined, true).flatMap((item) => item.files)).toHaveLength(2)
  })

  test('adds synthetic file headers to hunk-only and loose snippets', () => {
    expect(parsePatchFiles(normalizeDiffSnippet('@@ -2 +2 @@\n-old\n+new'), undefined, true)[0]?.files).toHaveLength(1)
    expect(parsePatchFiles(normalizeDiffSnippet('-old\r\n+new'), undefined, true)[0]?.files).toHaveLength(1)
  })

  test('rejects plain code that is mislabeled as diff', () => {
    expect(() => normalizeDiffSnippet('const value = 1')).toThrow('unified diff')
  })
})

