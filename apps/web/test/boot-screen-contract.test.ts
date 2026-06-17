import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const webRoot = resolve(import.meta.dir, '..')

function readWebFile(...parts: string[]) {
  return readFileSync(join(webRoot, ...parts), 'utf-8')
}

describe('boot static layer (index.html)', () => {
  const indexHtml = readWebFile('index.html')

  test('defines a #boot-root static layer', () => {
    expect(indexHtml).toContain('id="boot-root"')
    expect(indexHtml).toContain('/boot-logo.png')
  })

  test('applies the theme before first paint (no-flash)', () => {
    expect(indexHtml).toContain("localStorage.getItem('lume:theme-mode')")
    expect(indexHtml).toContain("classList.add('dark')")
    expect(indexHtml).toContain("prefers-color-scheme: dark")
  })

  test('static CSS uses violet brand fallback colors, not the example sage', () => {
    expect(indexHtml).not.toContain('147,167,123')
    expect(indexHtml).toContain('139,92,246')
  })
})

describe('boot logo asset', () => {
  test('public/boot-logo.png exists', () => {
    expect(existsSync(join(webRoot, 'public', 'boot-logo.png'))).toBe(true)
  })
})
