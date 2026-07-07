import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  PluginBridgeError,
  PluginBridgeService,
} from './plugin-bridge-service'

async function writeFile(path: string, content: string) {
  await mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function makeService(root: string, fetchImpl?: typeof fetch) {
  return new PluginBridgeService({
    installedRoot: join(root, 'plugins'),
    fetchImpl,
  })
}

describe('PluginBridgeService', () => {
  let root = ''
  let prevHome: string | undefined

  beforeEach(() => {
    prevHome = process.env.HOME
    root = mkdtempSync(join(tmpdir(), 'lume-bridge-'))
    process.env.HOME = root
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    if (root) rmSync(root, { recursive: true, force: true })
  })

  test('exportPluginArtifact 复制产物到 destDir', async () => {
    const artifactPath = join(root, 'plugins', 'demo', '1.0.0', 'ext.zip')
    await writeFile(artifactPath, 'zip-bytes')
    const result = await makeService(root).exportPluginArtifact({
      pluginId: 'demo',
      version: '1.0.0',
      artifactPath: './ext.zip',
      destDir: join(root, 'out'),
    })
    expect(result.savedPath).toBe(join(root, 'out', 'ext.zip'))
    expect(existsSync(result.savedPath)).toBe(true)
  })

  test('exportPluginArtifact 产物不存在时抛错', async () => {
    expect(
      makeService(root).exportPluginArtifact({
        pluginId: 'demo',
        version: '1.0.0',
        artifactPath: './missing.zip',
        destDir: join(root, 'out'),
      }),
    ).rejects.toBeInstanceOf(PluginBridgeError)
  })

  test('downloadBridgeAsset 下载并校验 sha256', async () => {
    const fetchImpl = (async () =>
      new Response('hello', { status: 200 })) as unknown as typeof fetch
    // sha256 of 'hello'
    const sha = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
    const result = await makeService(root, fetchImpl).downloadBridgeAsset({
      url: 'https://example.com/asset.bin',
      filename: 'asset.bin',
      sha256: sha,
      destDir: join(root, 'out'),
    })
    expect(result.verified).toBe(true)
    expect(existsSync(result.savedPath)).toBe(true)
  })

  test('checkBridgeStatus tcp-port 检测未监听端口返回 ok=false', async () => {
    const result = await makeService(root).checkBridgeStatus({
      pluginId: 'demo',
      version: '1.0.0',
      verify: { method: 'tcp-port', detail: '127.0.0.1:59999' },
    })
    expect(result.ok).toBe(false)
  })

  test('checkBridgeStatus tcp-port 拒绝非本地地址', async () => {
    expect(
      makeService(root).checkBridgeStatus({
        pluginId: 'demo',
        version: '1.0.0',
        verify: { method: 'tcp-port', detail: '8.8.8.8:53' },
      }),
    ).rejects.toBeInstanceOf(PluginBridgeError)
  })
})
