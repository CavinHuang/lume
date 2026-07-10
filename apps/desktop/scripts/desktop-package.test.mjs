import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DESKTOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = resolve(DESKTOP_ROOT, '..', '..')
const pkg = JSON.parse(readFileSync(resolve(DESKTOP_ROOT, 'package.json'), 'utf8'))

function assertContainsBefore(text, first, second) {
  const firstIndex = text.indexOf(first)
  const secondIndex = text.indexOf(second)

  assert.notEqual(firstIndex, -1, `missing ${first}`)
  assert.notEqual(secondIndex, -1, `missing ${second}`)
  assert.equal(firstIndex < secondIndex, true, `${first} must appear before ${second}`)
}

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

test('desktop package includes node-repl resources', () => {
  assert.deepEqual(
    pkg.build.extraResources.find((entry) => entry.to === 'node-repl'),
    {
      from: 'resources/node-repl',
      to: 'node-repl',
    },
  )
  assert.match(pkg.scripts.build, /build-node-repl-resources\.mjs/)
  assert.match(pkg.scripts.package, /build-node-repl-resources\.mjs/)
  assertContainsBefore(pkg.scripts.build, 'build-node-repl-resources.mjs', 'run-electron-builder.mjs')
  assertContainsBefore(pkg.scripts.package, 'build-node-repl-resources.mjs', 'run-electron-builder.mjs')
})

test('desktop package includes the optional desktop-host resource', () => {
  assert.deepEqual(
    pkg.build.extraResources.find((entry) => entry.to === 'desktop-host'),
    {
      from: 'resources/desktop-host',
      to: 'desktop-host',
    },
  )
  assert.match(pkg.scripts.build, /build-desktop-host-resources\.mjs/)
  assert.match(pkg.scripts.package, /build-desktop-host-resources\.mjs/)
  assertContainsBefore(pkg.scripts.build, 'build-desktop-host-resources.mjs', 'run-electron-builder.mjs')
  assertContainsBefore(pkg.scripts.package, 'build-desktop-host-resources.mjs', 'run-electron-builder.mjs')
})

test('desktop-host resource build ships the cursor reference license notice', () => {
  const script = readFileSync(resolve(REPO_ROOT, 'scripts/build-desktop-host-resources.mjs'), 'utf8')

  assert.match(script, /LICENSE\.open-codex-computer-use/)
})

test('desktop-host resource build packages macOS as a separate computer-use app bundle', () => {
  const script = readFileSync(resolve(REPO_ROOT, 'scripts/build-desktop-host-resources.mjs'), 'utf8')

  assert.match(script, /Lume Computer Use\.app/)
  assert.match(script, /Lume Computer Use \(Dev\)\.app/)
  assert.match(script, /com\.lume\.computer-use/)
  assert.match(script, /com\.lume\.computer-use\.dev/)
  assert.match(script, /LSUIElement/)
  assert.match(script, /CFBundleExecutable/)
  assert.match(script, /codesign/)
  assert.match(script, /LumeComputerUseAppVariant/)
  assert.match(script, /NSPrincipalClass/)
  assert.match(script, /NSApplication/)
  assert.match(script, /CFBundleIconFile/)
  assert.match(script, /LumeComputerUse\.icns/)
  assert.match(script, /apps", "desktop", "assets", "icon\.icns"/)
  assert.match(script, /plutil/)
  assert.match(script, /-lint/)
})

test('desktop-host resource build packages the macOS software cursor overlay', () => {
  const script = readFileSync(resolve(REPO_ROOT, 'scripts/build-desktop-host-resources.mjs'), 'utf8')

  assert.equal(
    existsSync(resolve(REPO_ROOT, 'crates/lume-desktop-host/macos/LumeComputerUseCursorOverlay.swift')),
    true,
  )
  assert.match(script, /LumeComputerUseCursorOverlay\.swift/)
  assert.match(script, /official-software-cursor-window-252\.png/)
  assert.match(script, /swiftc/)
  assert.match(script, /LumeComputerUseCursorOverlay/)
})

test('desktop-host resource build packages the macOS permission guide helper', () => {
  const script = readFileSync(resolve(REPO_ROOT, 'scripts/build-desktop-host-resources.mjs'), 'utf8')
  const guide = readFileSync(resolve(REPO_ROOT, 'crates/lume-desktop-host/macos/LumeComputerUsePermissionGuide.swift'), 'utf8')

  assert.equal(
    existsSync(resolve(REPO_ROOT, 'crates/lume-desktop-host/macos/LumeComputerUsePermissionGuide.swift')),
    true,
  )
  assert.match(script, /LumeComputerUsePermissionGuide\.swift/)
  assert.match(script, /LumeComputerUsePermissionGuide/)
  assert.match(script, /swiftc/)
  assert.match(script, /-framework",\s*"AppKit/)
  assert.doesNotMatch(guide, /AXIsProcessTrusted/)
  assert.doesNotMatch(guide, /CGPreflightScreenCaptureAccess/)
  assert.match(guide, /kTCCServiceAccessibility/)
  assert.match(guide, /kTCCServiceScreenCapture/)
  assert.match(guide, /\/usr\/bin\/sqlite3/)
  assert.match(guide, /Timer\.scheduledTimer/)
  assert.match(guide, /setPermissionGranted/)
  assert.match(guide, /DispatchQueue\.main\.asyncAfter/)
})

test('desktop-host resource build prefers a stable macOS signing identity', () => {
  const script = readFileSync(resolve(REPO_ROOT, 'scripts/build-desktop-host-resources.mjs'), 'utf8')

  assert.match(script, /LUME_COMPUTER_USE_CODESIGN_MODE\s*\?\?\s*["']auto["']/)
  assert.match(script, /find-identity/)
  assert.match(script, /Developer ID Application/)
  assert.match(script, /Apple Development/)
  assert.match(script, /--options["'],\s*["']runtime/)
  assert.match(script, /ad-hoc identity.*TCC/)
})

test('node-repl resource build clears generated output before writing resources', () => {
  const script = readFileSync(resolve(REPO_ROOT, 'scripts/build-node-repl-resources.mjs'), 'utf8')

  assertContainsBefore(script, 'rmSync(OUT_DIR, { recursive: true, force: true })', 'cpSync(SRC_DIR, OUT_DIR')
  assertContainsBefore(script, 'cpSync(SRC_DIR, OUT_DIR', 'build-node-repl-host.mjs')
})

test('desktop dev builds node-repl resources before launching Electron', () => {
  const script = readFileSync(resolve(DESKTOP_ROOT, 'scripts/dev.ts'), 'utf8')

  assert.match(script, /build-node-repl-resources\.mjs/)
  assertContainsBefore(script, 'spawnSync("node", [buildNodeReplResourcesScript]', 'spawn(electronBin')
})

test('desktop dev builds desktop-host resources before launching Electron', () => {
  const script = readFileSync(resolve(DESKTOP_ROOT, 'scripts/dev.ts'), 'utf8')

  assert.match(script, /build-desktop-host-resources\.mjs/)
  assertContainsBefore(script, 'spawnSync("node", [buildDesktopHostResourcesScript]', 'spawn(electronBin')
  assert.match(script, /LUME_COMPUTER_USE_BUNDLE_VARIANT:\s*["']dev["']/)
})
