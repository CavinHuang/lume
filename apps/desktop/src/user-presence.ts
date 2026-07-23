import { spawn } from 'node:child_process'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'

const USER_PRESENCE_PROTOCOL_VERSION = 1
const MAX_HELPER_OUTPUT_BYTES = 16 * 1024

type DesktopHostManifest = {
  version: number
  targets?: Record<string, {
    binary?: string
    sha256?: string
    userPresenceBinary?: string
    userPresenceSha256?: string
  }>
}

export type UserPresenceRequestOptions = {
  binaryPath: string
  manifestPath: string
  targetId: string
  nativeWindowHandle: Buffer
  reason: string
  timeoutMs?: number
}

export function nativeWindowHandleValue(buffer: Buffer): bigint | null {
  if (buffer.length !== 4 && buffer.length !== 8) return null
  let value = 0n
  for (let index = buffer.length - 1; index >= 0; index -= 1) {
    value = (value << 8n) | BigInt(buffer[index] ?? 0)
  }
  return value > 0n ? value : null
}

export function matchesDesktopHostManifest({
  binaryPath,
  manifestPath,
  targetId,
}: Pick<UserPresenceRequestOptions, 'binaryPath' | 'manifestPath' | 'targetId'>): boolean {
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as DesktopHostManifest
    const entry = manifest.version === 1 ? manifest.targets?.[targetId] : undefined
    const expectedName = entry?.userPresenceBinary ?? entry?.binary
    const expectedHash = entry?.userPresenceSha256 ?? entry?.sha256
    const expected = typeof expectedHash === 'string' && /^[a-f0-9]{64}$/i.test(expectedHash)
      ? Buffer.from(expectedHash.toLowerCase(), 'hex')
      : null
    if (!expected || expectedName !== binaryPath.split(/[\\/]/).pop()) return false
    const actual = Buffer.from(createHash('sha256').update(readFileSync(binaryPath)).digest('hex'), 'hex')
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

export async function requestFreshUserPresence(options: UserPresenceRequestOptions): Promise<boolean> {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return false
  if (!matchesDesktopHostManifest(options)) return false
  const windowHandle = nativeWindowHandleValue(options.nativeWindowHandle)
  if (process.platform === 'win32' && !windowHandle) return false
  const nonce = randomBytes(32).toString('hex')
  const request = {
    protocolVersion: USER_PRESENCE_PROTOCOL_VERSION,
    nonce,
    ...(windowHandle ? { windowHandle: windowHandle.toString() } : {}),
    parentPid: process.pid,
    parentExecutable: process.execPath,
    reason: options.reason.slice(0, 160),
  }

  return await new Promise<boolean>((resolve) => {
    const child = spawn(options.binaryPath, process.platform === 'win32' ? ['--authorize-user-presence'] : [], {
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let settled = false
    let stdout = Buffer.alloc(0)
    const finish = (authorized: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (child.exitCode === null) child.kill()
      resolve(authorized)
    }
    const timer = setTimeout(() => finish(false), options.timeoutMs ?? 60_000)
    child.once('error', () => finish(false))
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = Buffer.concat([stdout, chunk])
      if (stdout.length > MAX_HELPER_OUTPUT_BYTES) finish(false)
    })
    child.once('exit', (code) => {
      if (code !== 0 || settled) return finish(false)
      try {
        const response = JSON.parse(stdout.toString('utf8')) as Record<string, unknown>
        finish(
          response.protocolVersion === USER_PRESENCE_PROTOCOL_VERSION
          && response.nonce === nonce
          && response.parentPid === process.pid
          && response.authorized === true,
        )
      } catch {
        finish(false)
      }
    })
    child.stdin.end(`${JSON.stringify(request)}\n`)
  })
}
