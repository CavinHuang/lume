import test from 'node:test'
import crypto from 'node:crypto'
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
  assert.deepEqual(pkg.build.files, [
    'dist/main/main.mjs',
    'dist/preload/preload.cjs',
    'dist/preload/browser-auth-preload.cjs',
    'dist/preload/browser-guest-preload.cjs',
    'assets',
  ])
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
  assert.deepEqual(
    pkg.build.extraResources.find((entry) => entry.to === 'ripgrep'),
    {
      from: 'resources/ripgrep',
      to: 'ripgrep',
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

test('sidecar bundle removes sql.js build-machine paths before packaging', () => {
  const source = readFileSync(resolve(REPO_ROOT, 'scripts/build-sidecar-bundle.mjs'), 'utf8')
  assert.match(source, /sqlJsDirnamePattern/)
  assert.match(source, /sqlJsDirnamePattern,\s*'  var __dirname = "\.", __filename = "sql-wasm\.js";'/)
})

test('packaged desktop smoke uses an isolated profile and verifies the renderer', () => {
  assert.equal(pkg.scripts['test:packaged-smoke'], 'node ./scripts/packaged-desktop-smoke.mjs')
  const smokePath = resolve(DESKTOP_ROOT, 'scripts/packaged-desktop-smoke.mjs')
  assert.equal(existsSync(smokePath), true)
  const source = readFileSync(smokePath, 'utf8')
  assert.match(source, /--user-data-dir=/)
  assert.match(source, /DevToolsActivePort/)
  assert.match(source, /document\.readyState/)
})

test('live Chrome import smoke reports only aggregate encrypted-database compatibility', () => {
  assert.equal(pkg.scripts['test:browser-import-live-smoke'], 'node ./scripts/browser-import-live-smoke.mjs')
  const source = readFileSync(resolve(DESKTOP_ROOT, 'scripts/browser-import-live-smoke.mjs'), 'utf8')
  assert.match(source, /Chrome must remain open/)
  assert.match(source, /readChromeCookieRows/)
  assert.match(source, /SELECT password_value FROM logins/)
  assert.doesNotMatch(source, /row\.(origin_url|username_value|host_key|name)/)
  assert.doesNotMatch(source, /decryptChromeValue|importChromeProfile/)
})

test('Windows installer lets users choose the installation directory', () => {
  assert.equal(pkg.build.nsis?.oneClick, false)
  assert.equal(pkg.build.nsis?.allowToChangeInstallationDirectory, true)
})

test('macOS release uses Developer ID when configured and otherwise falls back to ad-hoc signing', () => {
  const workflow = readFileSync(resolve(REPO_ROOT, '.github/workflows/release-desktop.yml'), 'utf8')
  const installGuide = resolve(DESKTOP_ROOT, 'assets/mac-install-guide.txt')
  const afterPackPath = resolve(DESKTOP_ROOT, 'scripts/after-pack.cjs')

  assert.equal(pkg.build.mac?.hardenedRuntime, true)
  assert.equal(pkg.build.mac?.entitlements, 'assets/entitlements.mac.plist')
  assert.equal(pkg.build.mac?.entitlementsInherit, 'assets/entitlements.mac.plist')
  // askForMediaAccess('microphone') 依赖打包产物 Info.plist 的用途声明。
  assert.match(
    String(pkg.build.mac?.extendInfo?.NSMicrophoneUsageDescription ?? ''),
    /麦克风/,
  )
  assert.equal(pkg.build.afterPack, 'scripts/after-pack.cjs')
  assert.equal(existsSync(afterPackPath), true)
  const afterPack = readFileSync(afterPackPath, 'utf8')
  assert.match(afterPack, /electronPlatformName !== 'darwin'/)
  assert.match(afterPack, /LUME_RELEASE_SIGNING_REQUIRED === '1'/)
  assert.match(afterPack, /'--deep'/)
  assert.match(afterPack, /'--sign',\s*'-'/)
  assert.match(afterPack, /'--options',\s*'runtime'/)
  assert.match(afterPack, /'--entitlements',\s*entitlementsPath/)
  assert.match(afterPack, /'--timestamp=none'/)
  const entitlements = readFileSync(resolve(DESKTOP_ROOT, 'assets/entitlements.mac.plist'), 'utf8')
  assert.match(entitlements, /com\.apple\.security\.cs\.allow-jit/)
  assert.match(entitlements, /com\.apple\.security\.cs\.allow-unsigned-executable-memory/)
  assert.match(entitlements, /com\.apple\.security\.cs\.disable-library-validation/)
  assert.equal(existsSync(installGuide), true)
  assert.equal(
    pkg.build.dmg?.contents.some((entry) => entry.type === 'file' && entry.path === 'assets/mac-install-guide.txt'),
    true,
  )
  for (const secret of [
    'MACOS_CERTIFICATE_P12_BASE64',
    'MACOS_CERTIFICATE_PASSWORD',
    'APPLE_API_KEY_P8_BASE64',
    'APPLE_API_KEY_ID',
    'APPLE_API_ISSUER',
  ]) {
    assert.match(workflow, new RegExp(`secrets\\.${secret}`))
  }
  assert.match(workflow, /Configure optional macOS signing/)
  assert.match(workflow, /LUME_MAC_SIGNED_RELEASE=0/)
  assert.match(workflow, /LUME_COMPUTER_USE_CODESIGN_MODE=adhoc/)
  assert.match(workflow, /CSC_IDENTITY_AUTO_DISCOVERY=false/)
  assert.match(workflow, /LUME_MAC_SIGNED_RELEASE=1/)
  assert.match(workflow, /if: env\.LUME_MAC_SIGNED_RELEASE == '1'/)
  assert.match(workflow, /notarytool submit/)
  assert.match(workflow, /--config\.mac\.notarize="\$notarize"/)
  assert.match(workflow, /APPLE_API_KEY=/)
  assert.match(workflow, /stapler staple/)
  assert.match(workflow, /xcrun stapler validate/)
  assert.match(workflow, /codesign --verify --deep --strict/)
  assert.match(workflow, /Authority=Developer ID Application/)
  assert.match(workflow, /spctl --assess --type execute/)
  assert.doesNotMatch(workflow, /xattr -dr com\.apple\.quarantine/)
  assert.match(workflow, /retry gh release delete-asset/)
  assert.match(workflow, /upload_release_asset/)
  assert.match(workflow, /Invoke-ReleaseUpload/)
  assert.doesNotMatch(workflow, /--require-stable-signing/)
  assert.doesNotMatch(workflow, /Missing required macOS release secret/)
})

test('update installation keeps renderer IPC pending until the updater takes over', () => {
  const main = readFileSync(resolve(DESKTOP_ROOT, 'src/main.ts'), 'utf8')
  // update-install 注册经 handleLogged 包装（IPC 埋点），哨兵同步更新。
  const handlerStart = main.indexOf("handleLogged('lume:update:install'")
  const handlerEnd = main.indexOf('// Windows 任务栏图标', handlerStart)
  const handler = main.slice(handlerStart, handlerEnd)

  assert.notEqual(handlerStart, -1)
  assert.notEqual(handlerEnd, -1)
  assert.match(handler, /new Promise<never>/)
  assert.match(handler, /isQuitting = true/)
  assert.match(handler, /autoUpdater\.quitAndInstall\(false, true\)/)
  assert.doesNotMatch(handler, /autoUpdater\.quitAndInstall\(false, true\)\s*\n\s*return null/)
  assertContainsBefore(handler, 'isQuitting = true', 'autoUpdater.quitAndInstall(false, true)')
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
  assert.match(pkg.scripts.build, /build-ripgrep-resources\.mjs/)
  assert.match(pkg.scripts.package, /build-ripgrep-resources\.mjs/)
  assert.match(pkg.scripts.package, /build-node-repl-resources\.mjs/)
  assertContainsBefore(pkg.scripts.build, 'build-node-repl-resources.mjs', 'run-electron-builder.mjs')
  assertContainsBefore(pkg.scripts.package, 'build-node-repl-resources.mjs', 'run-electron-builder.mjs')
})

test('desktop package includes bundled capability plugins', () => {
  assert.deepEqual(
    pkg.build.extraResources.find((entry) => entry.to === 'bundled-plugins'),
    {
      from: '../sidecar/bundled-plugins',
      to: 'bundled-plugins',
    },
  )
  const main = readFileSync(resolve(DESKTOP_ROOT, 'src/main.ts'), 'utf8')
  assert.match(main, /LUME_BUNDLED_PLUGINS_DIR/)
  assert.match(main, /process\.resourcesPath, 'bundled-plugins'/)
  assert.match(main, /'apps', 'sidecar', 'bundled-plugins'/)
})

test('desktop package includes the Lume logo for the macOS tray', () => {
  assert.deepEqual(
    pkg.build.extraResources.find((entry) => entry.to === 'tray-icon.png'),
    {
      from: '../web/src/assets/imgs/logo.png',
      to: 'tray-icon.png',
    },
  )
  assert.equal(existsSync(resolve(REPO_ROOT, 'apps/web/src/assets/imgs/logo.png')), true)

  const main = readFileSync(resolve(DESKTOP_ROOT, 'src/main.ts'), 'utf8')
  const trayManager = readFileSync(resolve(DESKTOP_ROOT, 'src/tray-manager.ts'), 'utf8')
  assert.match(main, /process\.resourcesPath, 'tray-icon\.png'/)
  assert.doesNotMatch(trayManager, /setTemplateImage\(true\)/)
})

test('desktop package includes sidecar runtime data', () => {
  assert.deepEqual(
    pkg.build.extraResources.find((entry) => entry.to === 'data'),
    {
      from: 'resources/data',
      to: 'data',
    },
  )
  assert.deepEqual(
    pkg.build.extraResources.find((entry) => entry.to === 'package.json'),
    {
      from: 'resources/package.json',
      to: 'package.json',
    },
  )
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

test('desktop package limits the Agent Island helper to macOS resources', () => {
  const workflow = readFileSync(resolve(REPO_ROOT, '.github/workflows/release-desktop.yml'), 'utf8')
  const ciWorkflow = readFileSync(resolve(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8')
  const nativeBuild = readFileSync(resolve(REPO_ROOT, 'apps/desktop/scripts/build-agent-island-native.ts'), 'utf8')
  const verifier = readFileSync(resolve(REPO_ROOT, 'scripts/verify-desktop-package-inputs.mjs'), 'utf8')
  const helper = readFileSync(
    resolve(REPO_ROOT, 'packages/natives/agent-island/macos-agent-island-helper.swift'),
    'utf8',
  )

  assert.equal(pkg.build.extraResources.some((entry) => entry.to === 'agent-island'), false)
  assert.deepEqual(pkg.build.mac.extraResources, [
    {
      from: 'resources/agent-island',
      to: 'agent-island',
      filter: ['**/*'],
    },
  ])
  assertContainsBefore(
    workflow,
    'bun apps/desktop/scripts/build-agent-island-native.ts',
    'bun scripts/verify-desktop-package-inputs.mjs',
  )
  assert.match(ciWorkflow, /run: bun apps\/desktop\/scripts\/build-agent-island-native\.ts/)
  assert.match(nativeBuild, /arm64-apple-macos26\.0/)
  assert.match(nativeBuild, /x86_64-apple-macos26\.0/)
  assert.match(nativeBuild, /'lipo', '-create'/)
  assert.match(verifier, /process\.platform === "darwin"/)
  assert.match(verifier, /"agent-island", "macos-agent-island-helper"/)
  assert.match(helper, /"type": "unavailable", "message": "no notched display available"/)
  assert.match(helper, /private func refreshForDisplayChange\(\)[\s\S]*guard let preferredScreen = Self\.preferredScreen\(\)/)
  assert.match(helper, /if !displayAvailable \{[\s\S]*"type": "ready", "protocol": 1/)
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
  assert.doesNotMatch(script, /apps", "desktop", "assets", "icon\.icns"/)
  assert.match(script, /official-software-cursor-window-252\.png/)
  assert.match(script, /iconutil/)
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

test('desktop-host resource build compiles @main macOS helpers as libraries', () => {
  const script = readFileSync(resolve(REPO_ROOT, 'scripts/build-desktop-host-resources.mjs'), 'utf8')
  const swiftCompileBlocks = script.match(/spawnSync\("xcrun", \[\s*"swiftc",[\s\S]*?\], \{/g) ?? []

  assert.equal(swiftCompileBlocks.length, 5)
  for (const block of swiftCompileBlocks) {
    assert.match(block, /"-parse-as-library"/)
  }
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

test('desktop-host resource build packages the macOS context event monitor', () => {
  const script = readFileSync(resolve(REPO_ROOT, 'scripts/build-desktop-host-resources.mjs'), 'utf8')
  const helperPath = resolve(REPO_ROOT, 'crates/lume-desktop-host/macos/LumeComputerUseEventMonitor.swift')
  const helper = readFileSync(helperPath, 'utf8')

  assert.equal(existsSync(helperPath), true)
  assert.match(script, /LumeComputerUseEventMonitor\.swift/)
  assert.match(script, /LumeComputerUseEventMonitor/)
  assert.match(helper, /didActivateApplicationNotification/)
  assert.match(helper, /AXObserverCreate/)
  assert.match(helper, /kAXFocusedUIElementChangedNotification/)
  assert.match(helper, /kAXSelectedTextChangedNotification/)
  assert.match(helper, /kAXValueChangedNotification/)
  assert.match(helper, /foreground_changed/)
  assert.match(helper, /focus_changed/)
  assert.match(helper, /selection_changed/)
  assert.match(helper, /value_changed/)
  assert.match(helper, /scroll_changed/)
  assert.match(helper, /CGEvent\.tapCreate/)
  assert.match(helper, /interaction_changed/)
  assert.doesNotMatch(helper, /localizedName|bundleIdentifier|clipboard|kAXTitleAttribute|kAXValueAttribute|kAXSelectedTextAttribute/)
})

test('desktop-host resource build packages permission-free macOS app discovery', () => {
  const script = readFileSync(resolve(REPO_ROOT, 'scripts/build-desktop-host-resources.mjs'), 'utf8')
  const helperPath = resolve(REPO_ROOT, 'crates/lume-desktop-host/macos/LumeComputerUseAppDiscovery.swift')

  assert.equal(existsSync(helperPath), true)
  assert.match(script, /LumeComputerUseAppDiscovery\.swift/)
  assert.match(script, /LumeComputerUseAppDiscovery/)
  assert.match(readFileSync(helperPath, 'utf8'), /MDQueryCreate/)
})

test('desktop-host resource build prefers a stable macOS signing identity', () => {
  const script = readFileSync(resolve(REPO_ROOT, 'scripts/build-desktop-host-resources.mjs'), 'utf8')

  assert.match(script, /LUME_COMPUTER_USE_CODESIGN_MODE\s*\?\?\s*["']auto["']/)
  assert.match(script, /find-identity/)
  assert.match(script, /Developer ID Application/)
  assert.match(script, /Apple Development/)
  assert.match(script, /--options["'],\s*["']runtime/)
  assert.match(script, /ad-hoc identity.*TCC/)
  assert.match(script, /arm64-apple-macos14\.0/)
  assert.match(script, /x86_64-apple-macos14\.0/)
})

test('desktop package lets the macOS computer-use helper fall back to ad-hoc signing', () => {
  const script = readFileSync(resolve(REPO_ROOT, 'scripts/build-desktop-host-resources.mjs'), 'utf8')

  assert.doesNotMatch(pkg.scripts.package, /--require-stable-signing/)
  assert.doesNotMatch(script, /REQUIRE_STABLE_SIGNING/)
  assert.match(script, /\?\? "-"/)
  assert.match(script, /signed with ad-hoc identity/)
})

test('Windows release signs when credentials exist and otherwise keeps the unsigned smoke path', () => {
  const workflow = readFileSync(resolve(REPO_ROOT, '.github/workflows/release-desktop.yml'), 'utf8')
  const script = readFileSync(resolve(REPO_ROOT, 'scripts/build-desktop-host-resources.mjs'), 'utf8')

  assert.match(workflow, /secrets\.WINDOWS_CERTIFICATE_PFX_BASE64/)
  assert.match(workflow, /secrets\.WINDOWS_CERTIFICATE_PASSWORD/)
  assert.match(workflow, /Configure optional Windows signing/)
  assert.match(workflow, /LUME_WINDOWS_SIGNING_ENABLED=0/)
  assert.match(workflow, /LUME_WINDOWS_SIGNING_ENABLED=1/)
  assert.match(workflow, /if \(\$env:LUME_WINDOWS_SIGNING_ENABLED -eq "1"\)/)
  assert.match(workflow, /CSC_LINK=/)
  assert.match(workflow, /Get-AuthenticodeSignature/)
  assert.match(script, /hasWindowsSigningCredentials\(\)/)
  assert.match(script, /skipped Authenticode signing/)
  assert.match(script, /signWindowsBinary\(OUT_FILE\)/)
  assert.match(script, /"verify", "\/pa", "\/all"/)
  assert.doesNotMatch(workflow, /Missing required Windows release secret/)
  assert.doesNotMatch(workflow, /build-desktop-host-resources\.mjs --require-stable-signing/)
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

test('node-repl contract allowlist description matches worker.js (#639 review round-4)', () => {
  // allowlist（worker.js Set）与 contract 描述的人工枚举是另一对手工同步物；
  // 加模块忘改描述时在此变红。
  const workerSource = readFileSync(resolve(DESKTOP_ROOT, 'resources-src', 'node-repl', 'runtime', 'worker.js'), 'utf8')
  const setBody = workerSource.match(/const ALLOWED_BUILTIN_MODULES = new Set\(\[([\s\S]*?)\]\);/)?.[1] ?? ''
  const allowed = new Set([...setBody.matchAll(/"(node:[^"]+)"/g)].map((m) => m[1]))
  assert.ok(allowed.size > 0, 'ALLOWED_BUILTIN_MODULES must exist in worker.js')

  const contract = JSON.parse(readFileSync(resolve(REPO_ROOT, 'crates', 'lume-node-repl-host', 'contracts', 'node-repl-mcp-contract.json'), 'utf8'))
  const jsDescription = contract.tools.find((tool) => tool.name === 'js').description
  for (const specifier of allowed) {
    const short = specifier.replace(/^node:/, '')
    if (short.includes('/')) continue // 子路径条目在描述中单列，此处只核对主模块名
    assert.ok(jsDescription.includes(short), `contract js description missing allowed module "${short}"`)
  }
})

test('node-repl manifest hashes match the bundled resource files (#639 review)', () => {
  // manifest 哈希与资源文件靠人工同步；漂移会让生产侧按哈希拒载。CI 在此
  // 兜底：任何 resources-src/node-repl 下的文件改动都必须同步 manifest。
  const { createHash } = crypto
  const baseDir = resolve(DESKTOP_ROOT, 'resources-src', 'node-repl')
  const manifest = JSON.parse(readFileSync(resolve(baseDir, 'manifest.json'), 'utf8'))
  const entries = Object.entries(manifest.files ?? {})

  assert.ok(entries.length > 0, 'manifest.files must not be empty')
  for (const [relativePath, expected] of entries) {
    const actual = createHash('sha256')
      .update(readFileSync(resolve(baseDir, relativePath)))
      .digest('hex')
    assert.equal(actual, expected, `manifest hash drift for ${relativePath}`)
  }
})
