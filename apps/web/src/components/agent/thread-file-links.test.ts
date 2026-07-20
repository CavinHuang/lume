import { describe, expect, test } from 'bun:test'
import {
  normalizeThreadFilePathCandidate,
  parseMessageThreadFileReference,
  parseThreadFileReference,
  stripFileReferenceProtocolFromMarkdown,
} from './thread-file-links'

describe('message file reference protocol', () => {
  test('parses project/session references, directories, dotfiles and line ranges', () => {
    expect(parseThreadFileReference('@project/src/app.ts#L42-L48')).toMatchObject({
      source: 'project', relativePath: 'src/app.ts', isDirectory: false,
      lineSelection: { start: 42, end: 48 }, copyText: '项目/src/app.ts#L42-L48',
    })
    expect(parseThreadFileReference('@session/files/My%20Notes/')).toMatchObject({
      source: 'session', relativePath: 'files/My Notes', isDirectory: true, copyText: '会话/files/My Notes/',
    })
    expect(parseThreadFileReference('@project/.github/CODEOWNERS')).toMatchObject({
      relativePath: '.github/CODEOWNERS',
    })
    expect(parseThreadFileReference('@project/report/%23L42')).toMatchObject({ relativePath: 'report/#L42' })
  })

  test('strictly rejects traversal, absolute, backslash and encoded separators', () => {
    for (const value of [
      '@project/../secret', '@project/C:/secret', '@project/src\\app.ts', '@project/a/%2F/b',
      '@project/a/%5C/b', '@project/a/%00/b',
      '@project/', '@project/a//b', '@session/files/a.ts#L0', '@session/files/a.ts#L9-L2',
      '@session/files/#L2',
    ]) expect(parseThreadFileReference(value)).toBeNull()
    expect(parseThreadFileReference('@project/a/%252F/b')).toMatchObject({ relativePath: 'a/%2F/b' })
    expect(parseThreadFileReference('@project/a/%252e%252e/b')).toMatchObject({ relativePath: 'a/%2e%2e/b' })
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
    )).toBe('See `项目/src/app.ts#L4-L6` and [notes](会话/My%20Notes/a.md).')
  })

  test('accepts at most 64 path segments', () => {
    expect(parseThreadFileReference(`@project/${Array.from({ length: 64 }, () => 'a').join('/')}`)).not.toBeNull()
    expect(parseThreadFileReference(`@project/${Array.from({ length: 65 }, () => 'a').join('/')}`)).toBeNull()
  })

  test('fails closed for unknown versions and limits unbound old messages to legacy references', () => {
    expect(parseMessageThreadFileReference('@project/src/app.ts', { bindingPresent: true, protocolVersion: 2 })).toBeNull()
    expect(parseMessageThreadFileReference('@project/src/app.ts', { bindingPresent: false })).toBeNull()
    expect(parseMessageThreadFileReference('files/notes.md', { bindingPresent: false })).toMatchObject({ source: 'legacy-session' })
  })
})
