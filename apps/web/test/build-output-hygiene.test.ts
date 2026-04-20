import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const webRoot = resolve(import.meta.dir, '..')
const srcRoot = join(webRoot, 'src')

function collectFiles(root: string): string[] {
  const entries = readdirSync(root, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    const fullPath = join(root, entry.name)
    if (entry.isDirectory()) {
      files.push(...collectFiles(fullPath))
      continue
    }
    if (entry.isFile()) {
      files.push(fullPath)
    }
  }

  return files
}

describe('web build output hygiene', () => {
  test('TypeScript config and scripts should not emit JS into src', () => {
    const tsconfig = JSON.parse(
      readFileSync(join(webRoot, 'tsconfig.json'), 'utf-8')
    ) as {
      compilerOptions?: { noEmit?: boolean }
      exclude?: string[]
    }
    const pkg = JSON.parse(
      readFileSync(join(webRoot, 'package.json'), 'utf-8')
    ) as {
      scripts?: Record<string, string>
    }

    expect(tsconfig.compilerOptions?.noEmit).toBe(true)
    expect(tsconfig.exclude).toContain('src/**/*.test.ts')
    expect(pkg.scripts?.build).toContain('tsc --noEmit')
    expect(pkg.scripts?.typecheck).toContain('tsc --noEmit')
  })

  test('src should not contain emitted JS siblings for TS sources', () => {
    const extensionsByBase = new Map<string, Set<string>>()

    for (const filePath of collectFiles(srcRoot)) {
      const match = filePath.match(/\.(ts|tsx|js|jsx)$/)
      if (!match) continue

      const extension = `.${match[1]}`
      const basePath = filePath.slice(0, -extension.length)
      const existing = extensionsByBase.get(basePath) ?? new Set<string>()
      existing.add(extension)
      extensionsByBase.set(basePath, existing)
    }

    const emittedPairs = Array.from(extensionsByBase.entries())
      .filter(([, extensions]) => {
        const hasJs = extensions.has('.js') || extensions.has('.jsx')
        const hasTs = extensions.has('.ts') || extensions.has('.tsx')
        return hasJs && hasTs
      })
      .map(([basePath, extensions]) => ({
        path: basePath.replace(`${srcRoot}\\`, '').replace(/\\/g, '/'),
        extensions: Array.from(extensions).sort(),
      }))

    expect(emittedPairs).toEqual([])
  })
})
