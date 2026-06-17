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

describe('boot React CSS (lume-boot-screen.css)', () => {
  const css = readWebFile('src', 'components', 'boot', 'lume-boot-screen.css')

  test('uses app brand tokens, not the example sage palette', () => {
    expect(css).not.toContain('147,167,123')
    expect(css).toContain('var(--brand)')
    expect(css).toContain('var(--brand-2)')
  })

  test('derives background from app surface/background tokens', () => {
    expect(css).toContain('var(--surface-1)')
    expect(css).toContain('var(--background)')
  })

  test('keeps the four scene layers and keyframes', () => {
    expect(css).toContain('lume-boot-scene-organize')
    expect(css).toContain('lume-boot-scene-memory')
    expect(css).toContain('lume-boot-scene-ready')
    expect(css).toContain('@keyframes')
  })

  test('supports the fade-out class', () => {
    expect(css).toContain('.lume-boot-root.is-fading')
  })
})

describe('boot component (LumeBootScreen.tsx)', () => {
  const component = readWebFile('src', 'components', 'boot', 'LumeBootScreen.tsx')

  test('is driven by ready and removes the static layer on mount', () => {
    expect(component).toContain('ready')
    expect(component).toContain("getElementById('boot-root')")
    expect(component).toContain('.remove()')
  })

  test('renders the four scene layers and consumes boot-phase copy', () => {
    expect(component).toContain('lume-boot-scene-organize')
    expect(component).toContain('lume-boot-scene-memory')
    expect(component).toContain('lume-boot-scene-ready')
    expect(component).toContain('PHASE_COPY')
    expect(component).toContain('data-phase')
  })

  test('exports a barrel', () => {
    const barrel = readWebFile('src', 'components', 'boot', 'index.ts')
    expect(barrel).toContain('LumeBootScreen')
  })
})

describe('boot integration (App.tsx)', () => {
  const app = readWebFile('src', 'App.tsx')

  test('renders LumeBootScreen until boot is done', () => {
    expect(app).toContain('LumeBootScreen')
    expect(app).toContain('bootDone')
    expect(app).toContain('onExited')
  })

  test('keeps the healthcheck error branch', () => {
    expect(app).toContain('setError')
    expect(app).toContain('text-destructive')
  })

  test('uses the app logo as boot logo source', () => {
    expect(app).toContain('assets/imgs/logo.png')
  })
})
