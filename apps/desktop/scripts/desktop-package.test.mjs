import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DESKTOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(resolve(DESKTOP_ROOT, 'package.json'), 'utf8'))

test('desktop package uses Vite-built TypeScript runtime files', () => {
  assert.equal(pkg.main, 'dist/main/main.mjs')
  assert.equal(pkg.build.artifactName, '${productName}-${version}-${arch}.${ext}')
  assert.deepEqual(pkg.build.files, ['dist/main/main.mjs', 'dist/preload/preload.cjs', 'assets'])
  assert.equal(pkg.dependencies?.['electron-updater'], undefined)
  assert.equal(pkg.devDependencies?.['electron-updater'], '6.8.9')
  assert.equal(pkg.devDependencies?.electron, '42.5.1')
  assert.equal(pkg.devDependencies?.vite, '^6.3.0')
  assert.match(pkg.scripts.dev, /scripts\/dev\.ts/)
  assert.match(pkg.scripts.build, /scripts\/build\.ts/)
  assert.match(pkg.scripts.package, /scripts\/build\.ts/)
  assert.match(pkg.scripts.typecheck, /tsc -p tsconfig\.json/)
  assert.deepEqual(
    pkg.build.extraResources.find((entry) => entry.to === 'natives'),
    {
      from: 'resources/natives',
      to: 'natives',
    },
  )
  for (const file of [
    'vite.config.ts',
    'tsconfig.json',
    'src/main.ts',
    'src/preload.ts',
    'src/desktop-core.ts',
    'src/electron-security.ts',
    'src/sidecar-process.ts',
    'scripts/build.ts',
    'scripts/dev.ts',
  ]) {
    assert.equal(existsSync(resolve(DESKTOP_ROOT, file)), true, `missing ${file}`)
  }
})
