import { randomBytes as nodeRandomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

export function loadOrCreateDesktopContextKey({
  path,
  safeStorage,
  randomBytes = nodeRandomBytes,
}: {
  path: string
  safeStorage: SafeStorageLike
  randomBytes?: (size: number) => Buffer
}): Buffer {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Electron safe storage is unavailable')
  }
  if (existsSync(path)) {
    const decoded = Buffer.from(safeStorage.decryptString(readFileSync(path)), 'base64')
    if (decoded.length !== 32) throw new Error('wrapped desktop context key is invalid')
    return decoded
  }

  const key = randomBytes(32)
  if (key.length !== 32) throw new Error('desktop context key generator returned invalid data')
  const wrapped = safeStorage.encryptString(key.toString('base64'))
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temporary, wrapped)
  renameSync(temporary, path)
  return key
}
