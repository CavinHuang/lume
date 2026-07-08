import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { strFromU8, unzipSync } from 'fflate'
import {
  computeStorageStats,
  copyDirRecursive,
  createFileMetadata,
  createOpenFileDialogOptions,
  createOpenFolderDialogOptions,
  createUpdateDownloadProgressEvents,
  createUpdateFinishedEvent,
  createUpdateInfo,
  createWereadTipScript,
  decodeBase64Content,
  dirStats,
  ensureExistingPath,
  exportZip,
  readLauncherConfigFrom,
  readWindowBehaviorFromConfigDir,
  resolveConfigDirValue,
  restoreMainWindow,
  shouldHideToTray,
  validateExternalUrl,
  validateMigrationTarget,
  validateWereadUrl,
  writeWebLogRecord,
  resolveExistingPath,
  writeLauncherConfigAt,
  computeToggleAction,
  computeQuickInputBounds,
  getQuickInputUrl,
  buildTrayMenuTemplate,
  deriveTemplateImageBuffer,
} from '../src/desktop-core.ts'

function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

test('tray behavior hides only when tray is available, app is not quitting, and setting is enabled', () => {
  const behavior = { minimizeToTray: true, closeToTray: true }

  assert.equal(shouldHideToTray({ eventType: 'minimize', trayAvailable: true, isQuitting: false, windowBehavior: behavior }), true)
  assert.equal(shouldHideToTray({ eventType: 'close', trayAvailable: true, isQuitting: false, windowBehavior: behavior }), true)
  assert.equal(shouldHideToTray({ eventType: 'minimize', trayAvailable: false, isQuitting: false, windowBehavior: behavior }), false)
  assert.equal(shouldHideToTray({ eventType: 'close', trayAvailable: true, isQuitting: true, windowBehavior: behavior }), false)
  assert.equal(shouldHideToTray({ eventType: 'minimize', trayAvailable: true, isQuitting: false, windowBehavior: { minimizeToTray: false, closeToTray: true } }), false)
})

test('window behavior loads from existing settings without changing ~/.lume layout', () => {
  const dir = makeTempDir('lume-desktop-window-behavior-')
  try {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({
      generalSettings: {
        windowBehavior: {
          minimizeToTray: true,
          closeToTray: true,
          showTray: false,
        },
      },
    }))

    assert.deepEqual(readWindowBehaviorFromConfigDir(dir), {
      minimizeToTray: true,
      closeToTray: true,
      showTray: false,
    })

    writeFileSync(join(dir, 'settings.json'), JSON.stringify({
      generalSettings: {
        windowBehavior: {
          minimizeToTray: true,
        },
      },
    }))

    assert.deepEqual(readWindowBehaviorFromConfigDir(dir), {
      minimizeToTray: true,
      closeToTray: false,
      showTray: true,
    })
    assert.deepEqual(readWindowBehaviorFromConfigDir(join(dir, 'missing')), {
      minimizeToTray: false,
      closeToTray: false,
      showTray: true,
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('show main window restores minimized windows before showing and focusing', () => {
  const calls = []
  const win = {
    isDestroyed: () => false,
    isMinimized: () => true,
    restore: () => calls.push('restore'),
    show: () => calls.push('show'),
    focus: () => calls.push('focus'),
  }

  assert.equal(restoreMainWindow(win), true)
  assert.deepEqual(calls, ['restore', 'show', 'focus'])
  assert.equal(restoreMainWindow(null), false)
  assert.equal(restoreMainWindow({ isDestroyed: () => true }), false)
})

test('file and folder dialog options match desktop selection contracts', () => {
  assert.deepEqual(createOpenFileDialogOptions(), {
    properties: ['openFile', 'multiSelections'],
    filters: [
      {
        name: 'Supported Files',
        extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'txt', 'md', 'json', 'csv', 'xml', 'html', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'odp', 'ods'],
      },
    ],
  })
  assert.deepEqual(createOpenFolderDialogOptions(), {
    properties: ['openDirectory'],
  })
})

test('file metadata matches desktop IPC payload shape and encodes image data', () => {
  const dir = makeTempDir('lume-desktop-file-')
  try {
    const textFile = join(dir, 'note.txt')
    const imageFile = join(dir, 'pixel.png')
    writeFileSync(textFile, 'hello')
    writeFileSync(imageFile, Buffer.from([0x89, 0x50, 0x4e, 0x47]))

    assert.deepEqual(createFileMetadata(textFile), {
      filename: 'note.txt',
      mediaType: 'text/plain',
      size: 5,
      sourcePath: textFile,
    })

    assert.deepEqual(createFileMetadata(imageFile), {
      filename: 'pixel.png',
      mediaType: 'image/png',
      size: 4,
      sourcePath: imageFile,
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
    })

    assert.throws(() => createFileMetadata(dir), /path is not a file/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('system file helpers preserve old path validation and base64 errors', () => {
  const dir = makeTempDir('lume-desktop-system-file-')
  try {
    const file = join(dir, 'note.txt')
    writeFileSync(file, 'hello')

    assert.equal(ensureExistingPath(file), file)
    assert.equal(resolveExistingPath(file), realpathSync(file))
    assert.deepEqual(decodeBase64Content(Buffer.from('hello').toString('base64')), Buffer.from('hello'))
    assert.throws(() => ensureExistingPath(join(dir, 'missing.txt')), /路径不存在/)
    assert.throws(() => decodeBase64Content('not base64!'), /图片数据解析失败/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('external URLs are restricted to http and https', () => {
  assert.equal(validateExternalUrl('https://example.com/path'), 'https://example.com/path')
  assert.equal(validateExternalUrl('http://example.com/path'), 'http://example.com/path')
  assert.throws(() => validateExternalUrl('file:///tmp/secret'), /only http\/https urls are allowed/)
  assert.throws(() => validateExternalUrl('javascript:alert(1)'), /only http\/https urls are allowed/)
})

test('WeRead auth window only accepts the expected weread skills URL', () => {
  assert.equal(
    validateWereadUrl('https://weread.qq.com/r/weread-skills?from=lume'),
    'https://weread.qq.com/r/weread-skills?from=lume',
  )
  assert.throws(() => validateWereadUrl('https://weread.qq.com/web/reader'), /only https:\/\/weread\.qq\.com\/r\/weread-skills is allowed/)
  assert.throws(() => validateWereadUrl('http://weread.qq.com/r/weread-skills'), /only https:\/\/weread\.qq\.com\/r\/weread-skills is allowed/)
  assert.match(createWereadTipScript(), /lume-weread-key-tip/)
})

test('storage stats skip configured derived subdirectories without changing config layout', () => {
  const dir = makeTempDir('lume-desktop-stats-')
  try {
    mkdirSync(join(dir, 'memory', 'index'), { recursive: true })
    mkdirSync(join(dir, 'memory', 'entries'), { recursive: true })
    mkdirSync(join(dir, 'logs'), { recursive: true })
    writeFileSync(join(dir, 'memory', 'index', 'vec.json'), 'xxxxx')
    writeFileSync(join(dir, 'memory', 'entries', 'e.md'), 'yyy')
    writeFileSync(join(dir, 'logs', 'l.ndjson'), 'zz')

    assert.deepEqual(computeStorageStats(dir, [
      { key: 'core', scanPaths: ['memory'], skipSubdirs: ['memory/index'] },
      { key: 'derived', scanPaths: ['memory/index', 'logs'], skipSubdirs: [] },
    ]), {
      total: 10,
      configDir: dir,
      categories: [
        { key: 'core', bytes: 3 },
        { key: 'derived', bytes: 7 },
      ],
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('storage stats do not descend into per-thread lume config snapshots', () => {
  const dir = makeTempDir('lume-desktop-stats-nested-config-')
  try {
    const threadRoot = join(dir, 'agent-workspaces', 'default', 'threads', 'thread-a')
    const snapshotRoot = join(threadRoot, '.lume-config')
    const nestedThreadRoot = join(snapshotRoot, 'agent-workspaces', 'default', 'threads', 'thread-a')
    const nestedSnapshotRoot = join(nestedThreadRoot, '.lume-config')

    mkdirSync(nestedSnapshotRoot, { recursive: true })
    writeFileSync(join(threadRoot, 'message.jsonl'), 'live')
    writeFileSync(join(snapshotRoot, 'settings.json'), 'snapshot')
    writeFileSync(join(nestedThreadRoot, 'message.jsonl'), 'nested')
    writeFileSync(join(nestedSnapshotRoot, 'settings.json'), 'deeper')

    assert.deepEqual(computeStorageStats(dir, [
      {
        key: 'core',
        scanPaths: ['agent-workspaces/*/threads'],
        skipSubdirs: [],
      },
    ]), {
      total: 4,
      configDir: dir,
      categories: [
        { key: 'core', bytes: 4 },
      ],
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('data export zip redacts JSON credentials and keeps non-JSON files unchanged', () => {
  const dir = makeTempDir('lume-desktop-export-')
  const zipPath = join(tmpdir(), `lume-export-${process.pid}-${Date.now()}.zip`)
  try {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ apiKey: 'sk-secret', name: 'ok' }))
    writeFileSync(join(dir, 'note.txt'), 'plain text')

    const result = exportZip(dir, { destPath: zipPath, includeCredentials: false })
    assert.equal(result.fileCount, 2)
    assert.equal(result.credentialsStripped, true)
    assert.equal(readFileSync(zipPath).byteLength, result.bytes)

    const archive = unzipSync(readFileSync(zipPath))
    const settings = strFromU8(archive['settings.json'])
    assert.match(settings, /\[REDACTED\]/)
    assert.doesNotMatch(settings, /sk-secret/)
    assert.equal(strFromU8(archive['note.txt']), 'plain text')
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(zipPath, { force: true })
  }
})

test('data export zip does not include per-thread lume config snapshots', () => {
  const dir = makeTempDir('lume-desktop-export-nested-config-')
  const zipPath = join(tmpdir(), `lume-export-nested-${process.pid}-${Date.now()}.zip`)
  try {
    const threadRoot = join(dir, 'agent-workspaces', 'default', 'threads', 'thread-a')
    const snapshotRoot = join(threadRoot, '.lume-config')

    mkdirSync(snapshotRoot, { recursive: true })
    writeFileSync(join(threadRoot, 'message.jsonl'), 'live')
    writeFileSync(join(snapshotRoot, 'settings.json'), JSON.stringify({ apiKey: 'sk-secret' }))

    const result = exportZip(dir, { destPath: zipPath, includeCredentials: false })
    assert.equal(result.fileCount, 1)

    const archive = unzipSync(readFileSync(zipPath))
    assert.equal(strFromU8(archive['agent-workspaces/default/threads/thread-a/message.jsonl']), 'live')
    assert.equal(archive['agent-workspaces/default/threads/thread-a/.lume-config/settings.json'], undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(zipPath, { force: true })
  }
})

test('web logs are written to the existing lume log file format with webview source', () => {
  const dir = makeTempDir('lume-desktop-web-log-')
  try {
    writeWebLogRecord(dir, {
      level: 'warn',
      source: 'sidecar',
      context: 'renderer',
      message: 'hello',
      data: { ok: true },
      path: join(dir, 'should-not-control-log-output.ndjson'),
    }, new Date('2026-06-30T01:02:03.456Z'))

    const line = readFileSync(join(dir, 'logs', 'lume-2026-06-30.ndjson'), 'utf8').trim()
    assert.deepEqual(JSON.parse(line), {
      ts: '2026-06-30T01:02:03.456Z',
      timestamp: '2026-06-30T01:02:03.456Z',
      level: 'warn',
      source: 'renderer',
      context: 'renderer',
      message: 'hello',
      data: { ok: true },
    })
    assert.equal(existsSync(join(dir, 'should-not-control-log-output.ndjson')), false)
    assert.throws(() => writeWebLogRecord(dir, { level: 'verbose', context: 'renderer', message: 'bad' }), /invalid log level/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('migration validation is component-aware and recursive copy preserves stats', () => {
  const root = makeTempDir('lume-desktop-migrate-')
  const source = join(root, 'src')
  const siblingWithPrefix = join(root, 'src-new')
  const insideSource = join(source, 'child')
  const containsSource = root
  const copied = join(root, 'copied')
  try {
    mkdirSync(join(source, 'a', 'b'), { recursive: true })
    writeFileSync(join(source, 'a', 'b', 'x.txt'), 'hello')
    writeFileSync(join(source, 'a', 'y.json'), '{}')
    mkdirSync(siblingWithPrefix)

    assert.doesNotThrow(() => validateMigrationTarget(source, siblingWithPrefix))
    assert.throws(() => validateMigrationTarget(source, source), /目标不能与当前数据目录相同/)
    assert.throws(() => validateMigrationTarget(source, insideSource), /目标不能在当前数据目录内/)
    assert.throws(() => validateMigrationTarget(source, containsSource), /目标不能包含当前数据目录/)

    const result = copyDirRecursive(source, copied)
    assert.deepEqual(result, { copiedFiles: 2, copiedBytes: 7 })
    assert.deepEqual(dirStats(copied), { files: 2, bytes: 7 })
    assert.equal(readFileSync(join(copied, 'a', 'b', 'x.txt'), 'utf8'), 'hello')
    assert.equal(readFileSync(join(copied, 'a', 'y.json'), 'utf8'), '{}')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('launcher config roundtrips without changing ~/.lume fallback semantics', () => {
  const dir = makeTempDir('lume-desktop-launcher-')
  const launcherPath = join(dir, 'launcher.json')
  try {
    const configDir = resolve(dir, 'new-config')
    const oldDir = resolve(dir, 'old-config')
    writeLauncherConfigAt(launcherPath, { configDir, pendingDeleteOld: oldDir })

    assert.deepEqual(readLauncherConfigFrom(launcherPath), { configDir, pendingDeleteOld: oldDir })
    const cwd = resolve(dir, 'workspace')
    assert.equal(resolveConfigDirValue('relative-lume-dir', cwd), resolve(cwd, 'relative-lume-dir'))
    assert.equal(resolveConfigDirValue('', dir), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('update info mirrors renderer contract and normalizes release notes', () => {
  assert.equal(createUpdateInfo(null, '0.0.6'), null)
  assert.deepEqual(
    createUpdateInfo({
      version: '0.0.7',
      releaseDate: '2026-06-30T00:00:00.000Z',
      releaseNotes: [{ version: '0.0.7', note: 'Fix desktop' }, 'Plain note'],
    }, '0.0.6'),
    {
      currentVersion: '0.0.6',
      version: '0.0.7',
      date: '2026-06-30T00:00:00.000Z',
      body: '0.0.7\nFix desktop\nPlain note',
    },
  )
})

test('update download events preserve renderer progress contract', () => {
  const state = { previousTransferred: 0, started: false }

  assert.deepEqual(createUpdateDownloadProgressEvents(state, { transferred: 40, total: 100 }), [
    { event: 'Started', data: { contentLength: 100 } },
    { event: 'Progress', data: { chunkLength: 40, contentLength: 100 } },
  ])
  assert.deepEqual(createUpdateDownloadProgressEvents(state, { transferred: 75, total: 100 }), [
    { event: 'Progress', data: { chunkLength: 35, contentLength: 100 } },
  ])
  assert.deepEqual(createUpdateDownloadProgressEvents(state, { transferred: 70 }), [
    { event: 'Progress', data: { chunkLength: 0, contentLength: null } },
  ])
  assert.deepEqual(createUpdateFinishedEvent(), { event: 'Finished', data: {} })
})

test("computeToggleAction returns the right quick-input visibility transition", () => {
  assert.equal(computeToggleAction({ exists: false, visible: false }), "create");
  assert.equal(computeToggleAction({ exists: true, visible: false }), "show");
  assert.equal(computeToggleAction({ exists: true, visible: true }), "hide");
  assert.equal(computeToggleAction({ exists: true, visible: true, destroyed: true }), "create");
});

test("computeQuickInputBounds centers and caps height at main-window height (920)", () => {
  const bounds = computeQuickInputBounds({ width: 1920, height: 1080 });
  assert.equal(bounds.width, 760);
  assert.equal(bounds.height, 920);
  assert.equal(bounds.x, Math.round((1920 - 760) / 2));
  assert.equal(bounds.y, Math.round((1080 - 920) / 2));
  const small = computeQuickInputBounds({ width: 800, height: 500 });
  assert.equal(small.height, 500);
  assert.equal(small.x >= 0, true);
  assert.equal(small.y, 0);
});

test("getQuickInputUrl builds dev and packaged entry urls with the view flag", () => {
  assert.equal(
    getQuickInputUrl({
      appIsPackaged: false,
      appProtocolOrigin: "lume://app",
      devServerUrl: "http://127.0.0.1:3000",
    }),
    "http://127.0.0.1:3000/?view=quick-input",
  );
  assert.equal(
    getQuickInputUrl({
      appIsPackaged: true,
      appProtocolOrigin: "lume://app",
      devServerUrl: "http://127.0.0.1:3000",
    }),
    "lume://app/index.html?view=quick-input",
  );
});

test('tray menu template toggles Show/Hide label by window visibility', () => {
  const hidden = buildTrayMenuTemplate({ windowVisible: false })
  assert.equal(hidden[0].label, 'Show Lume')
  assert.equal(hidden[0].action, 'toggle-window')
  assert.equal(hidden[hidden.length - 1].label, 'Quit')
  assert.equal(hidden[hidden.length - 1].action, 'quit')

  const visible = buildTrayMenuTemplate({ windowVisible: true })
  assert.equal(visible[0].label, 'Hide Lume')
  assert.equal(visible[0].action, 'toggle-window')
});

test('deriveTemplateImageBuffer produces black pixels preserving original alpha', () => {
  // 像素：红不透明白、绿半透明、透明（alpha=0）
  const rgba = Buffer.from([
    255, 0, 0, 255,
    0, 255, 0, 128,
    0, 0, 0, 0,
  ])
  const out = deriveTemplateImageBuffer(rgba, { width: 3, height: 1 })
  assert.deepEqual(
    Array.from(out),
    [0, 0, 0, 255, 0, 0, 0, 128, 0, 0, 0, 0],
  )
})
