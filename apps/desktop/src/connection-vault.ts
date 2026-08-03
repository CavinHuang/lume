import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

export interface ConnectionVaultSafeStorage {
  isEncryptionAvailable(): boolean
  getSelectedStorageBackend?(): string
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

interface WrappedKey {
  iv: string
  tag: string
  ciphertext: string
}

interface ConnectionVaultKeyFile {
  version: 1
  kdf: {
    name: 'scrypt'
    salt: string
    cost: number
    blockSize: number
    parallelization: number
  }
  passwordWrappedKey: WrappedKey
  deviceWrappedKey: string
  createdAt: number
}

const SCRYPT_COST = 1 << 15
const SCRYPT_BLOCK_SIZE = 8
const SCRYPT_PARALLELIZATION = 1

function isSecureStorage(storage: ConnectionVaultSafeStorage): boolean {
  return storage.isEncryptionAvailable()
    && (typeof storage.getSelectedStorageBackend !== 'function'
      || storage.getSelectedStorageBackend() !== 'basic_text')
}

function readKeyFile(path: string): ConnectionVaultKeyFile {
  const value = JSON.parse(readFileSync(path, 'utf8')) as ConnectionVaultKeyFile
  if (
    value.version !== 1
    || value.kdf?.name !== 'scrypt'
    || !value.passwordWrappedKey
    || typeof value.deviceWrappedKey !== 'string'
  ) {
    throw new Error('connection_vault_record_invalid')
  }
  return value
}

function derivePasswordKey(password: string, record: Pick<ConnectionVaultKeyFile, 'kdf'>): Buffer {
  return scryptSync(password, Buffer.from(record.kdf.salt, 'base64'), 32, {
    N: record.kdf.cost,
    r: record.kdf.blockSize,
    p: record.kdf.parallelization,
    maxmem: 64 * 1024 * 1024,
  })
}

function wrapKey(masterKey: Buffer, wrappingKey: Buffer): WrappedKey {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', wrappingKey, iv)
  const ciphertext = Buffer.concat([cipher.update(masterKey), cipher.final()])
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  }
}

function unwrapKey(record: WrappedKey, wrappingKey: Buffer): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', wrappingKey, Buffer.from(record.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(record.tag, 'base64'))
  const value = Buffer.concat([
    decipher.update(Buffer.from(record.ciphertext, 'base64')),
    decipher.final(),
  ])
  if (value.length !== 32) {
    value.fill(0)
    throw new Error('connection_vault_key_invalid')
  }
  return value
}

function atomicWrite(path: string, value: ConnectionVaultKeyFile): void {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  renameSync(temporary, path)
}

export function getConnectionVaultStatus(input: {
  path: string
  safeStorage: ConnectionVaultSafeStorage
}): { configured: boolean; secureStorageAvailable: boolean } {
  return {
    configured: existsSync(input.path),
    secureStorageAvailable: isSecureStorage(input.safeStorage),
  }
}

export function setupConnectionVault(input: {
  path: string
  password: string
  safeStorage: ConnectionVaultSafeStorage
}): Buffer {
  if (existsSync(input.path)) throw new Error('connection_vault_already_configured')
  if (!isSecureStorage(input.safeStorage)) throw new Error('connection_vault_secure_storage_unavailable')
  if (input.password.length < 8) throw new Error('connection_vault_password_too_short')

  const masterKey = randomBytes(32)
  const salt = randomBytes(16)
  const record: ConnectionVaultKeyFile = {
    version: 1,
    kdf: {
      name: 'scrypt',
      salt: salt.toString('base64'),
      cost: SCRYPT_COST,
      blockSize: SCRYPT_BLOCK_SIZE,
      parallelization: SCRYPT_PARALLELIZATION,
    },
    passwordWrappedKey: { iv: '', tag: '', ciphertext: '' },
    deviceWrappedKey: '',
    createdAt: Date.now(),
  }
  const passwordKey = derivePasswordKey(input.password, record)
  try {
    record.passwordWrappedKey = wrapKey(masterKey, passwordKey)
    record.deviceWrappedKey = input.safeStorage.encryptString(masterKey.toString('base64')).toString('base64')
    atomicWrite(input.path, record)
    return Buffer.from(masterKey)
  } finally {
    passwordKey.fill(0)
    masterKey.fill(0)
  }
}

export function autoUnlockConnectionVault(input: {
  path: string
  safeStorage: ConnectionVaultSafeStorage
}): Buffer | undefined {
  if (!existsSync(input.path)) return undefined
  if (!isSecureStorage(input.safeStorage)) throw new Error('connection_vault_secure_storage_unavailable')
  const record = readKeyFile(input.path)
  const value = Buffer.from(input.safeStorage.decryptString(Buffer.from(record.deviceWrappedKey, 'base64')), 'base64')
  if (value.length !== 32) {
    value.fill(0)
    throw new Error('connection_vault_key_invalid')
  }
  return value
}

export function verifyConnectionVaultPassword(input: {
  path: string
  password: string
}): boolean {
  let masterKey: Buffer | undefined
  try {
    masterKey = unlockConnectionVaultWithPassword(input)
    return true
  } catch {
    return false
  } finally {
    masterKey?.fill(0)
  }
}

export function unlockConnectionVaultWithPassword(input: {
  path: string
  password: string
}): Buffer {
  if (!existsSync(input.path)) throw new Error('connection_vault_not_configured')
  const record = readKeyFile(input.path)
  const passwordKey = derivePasswordKey(input.password, record)
  try {
    return unwrapKey(record.passwordWrappedKey, passwordKey)
  } catch {
    throw new Error('connection_vault_password_invalid')
  } finally {
    passwordKey.fill(0)
  }
}
