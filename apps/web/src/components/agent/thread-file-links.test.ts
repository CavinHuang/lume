import { describe, expect, test } from 'bun:test'
import {
  normalizeThreadFilePathCandidate,
  parseThreadFileReference,
  stripFileReferenceProtocolFromMarkdown,
} from './thread-file-links'

describe('message file reference protocol', () => {
  test('parses project/session references, directories, dotfiles and line ranges', () => {
    expect(parseThreadFileReference('@project/src/app.ts#L42-L48')).toMatchObject({
      source: 'project', relativePath: 'src/app.ts', isDirectory: false,
      lineSelection: { start: 42, end: 48 }, copyText: 'src/app.ts#L42-L48',
    })
    expect(parseThreadFileReference('@session/files/My%20Notes/')).toMatchObject({
      source: 'session', relativePath: 'files/My Notes', isDirectory: true, copyText: 'files/My Notes/',
    })
    expect(parseThreadFileReference('@project/.github/CODEOWNERS')).toMatchObject({
      relativePath: '.github/CODEOWNERS',
    })
    expect(parseThreadFileReference('@project/report/%23L42')).toMatchObject({ relativePath: 'report/#L42' })
  })

  test('strictly rejects traversal, absolute, backslash, encoded separators and double encoding', () => {
    for (const value of [
      '@project/../secret', '@project/C:/secret', '@project/src\\app.ts', '@project/a/%2F/b',
      '@project/a/%5C/b', '@project/a/%252F/b', '@project/a/%252e%252e/b', '@project/a/%00/b',
      '@project/', '@project/a//b', '@session/files/a.ts#L0', '@session/files/a.ts#L9-L2',
      '@session/files/#L2',
    ]) expect(parseThreadFileReference(value)).toBeNull()
  })

  test('markdown href requires encoded spaces and decodes exactly once', () => {
    expect(parseThreadFileReference('@project/My Notes/readme.md', { markdownHref: true })).toBeNull()
    expect(parseThreadFileReference('@project/My%20Notes/readme.md', { markdownHref: true })?.relativePath)
      .toBe('My Notes/readme.md')
  })

  test('preserves the narrow legacy session heuristic including Windows separators', () => {
    expect(parseThreadFileReference('files\\notes.md')).toMatchObject({
      source: 'legacy-session', relativePath: 'files/notes.md', copyText: 'files/notes.md',
    })
    expect(normalizeThreadFilePathCandidate('notes.md')).toBeNull()
    expect(parseThreadFileReference('/tmp/notes.md')).toBeNull()
    expect(parseThreadFileReference('files/README')).toBeNull()
  })

  test('removes internal protocol prefixes from whole-message copy text', () => {
    expect(stripFileReferenceProtocolFromMarkdown(
      'See `@project/src/app.ts#L4-L6` and [notes](@session/My%20Notes/a.md).',
    )).toBe('See `src/app.ts#L4-L6` and [notes](My%20Notes/a.md).')
  })
})
