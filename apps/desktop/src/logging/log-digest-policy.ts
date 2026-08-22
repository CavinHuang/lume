import { createHmac, randomBytes as nodeRandomBytes } from 'node:crypto'
import type { LumeLogDigestPolicy } from '@lume/shared'
import { loadOrCreateDesktopContextKey } from '../desktop-context-key'

interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
  getSelectedStorageBackend?(): string
}

const ROOT_KEY_BYTES = 32
const SIDECAR_DERIVATION_CONTEXT = 'lume/log-digest/sidecar/v1'

export function isSafeStorageSecure(safeStorage: SafeStorageLike): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false
  return typeof safeStorage.getSelectedStorageBackend !== 'function'
    || safeStorage.getSelectedStorageBackend() !== 'basic_text'
}

export function createSidecarLogDigestPolicy({
  rootKeyPath,
  safeStorage,
  allowPersistentKey,
  randomBytes = nodeRandomBytes,
}: {
  rootKeyPath: string
  safeStorage: SafeStorageLike
  allowPersistentKey: boolean
  randomBytes?: (size: number) => Buffer
}): LumeLogDigestPolicy {
  const persistent = allowPersistentKey && safeStorage.isEncryptionAvailable()
  const rootKey = persistent
    ? loadOrCreateDesktopContextKey({ path: rootKeyPath, safeStorage, randomBytes })
    : randomBytes(ROOT_KEY_BYTES)
  if (rootKey.length !== ROOT_KEY_BYTES) throw new Error('log digest root key generator returned invalid data')

  try {
    const key = createHmac('sha256', rootKey)
      .update(SIDECAR_DERIVATION_CONTEXT, 'utf8')
      .digest('base64')
    return {
      schemaVersion: 1,
      algorithm: 'hmac-sha256',
      keyVersion: 1,
      scope: persistent ? 'install' : 'session',
      key,
    }
  } finally {
    rootKey.fill(0)
  }
}

export function createLogContentDigest(
  policy: LumeLogDigestPolicy,
  content: string,
  purpose: string,
): string {
  const key = Buffer.from(policy.key, 'base64')
  try {
    return createHmac('sha256', key)
      .update(purpose, 'utf8')
      .update('\0')
      .update(content, 'utf8')
      .digest('hex')
  } finally {
    key.fill(0)
  }
}
