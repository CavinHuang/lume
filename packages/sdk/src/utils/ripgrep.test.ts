import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveRipgrepInvocation } from './ripgrep.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('resolveRipgrepInvocation', () => {
  test('prefers explicit sandbox configuration over bundled resources', () => {
    expect(resolveRipgrepInvocation({ ripgrep: { command: 'custom-rg', args: ['--hidden'] } }, { LUME_RIPGREP_PATH: 'ignored' })).toEqual({
      command: 'custom-rg', args: ['--hidden'], source: 'configured',
    })
  })

  test('uses the bundled executable when the desktop process provides it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lume-ripgrep-'))
    roots.push(root)
    const binary = join(root, 'rg.exe')
    await writeFile(binary, 'placeholder')

    expect(resolveRipgrepInvocation(undefined, { LUME_RIPGREP_PATH: binary })).toMatchObject({
      command: binary, source: 'bundled', executableDirectory: root,
    })
  })

  test('uses PATH lookup only when no configured or bundled binary exists', () => {
    expect(resolveRipgrepInvocation(undefined, {})).toEqual({ command: 'rg', args: [], source: 'system' })
  })
})
