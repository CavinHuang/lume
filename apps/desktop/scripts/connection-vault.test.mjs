import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  autoUnlockConnectionVault,
  getConnectionVaultStatus,
  setupConnectionVault,
  unlockConnectionVaultWithPassword,
  verifyConnectionVaultPassword,
} from '../src/connection-vault.ts'

const safeStorage = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'dpapi',
  encryptString: (value) => Buffer.from(`device:${value}`, 'utf8'),
  decryptString: (value) => value.toString('utf8').slice('device:'.length),
}

describe('connection vault', () => {
  let directory = ''

  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true })
  })

  test('sets a password once and auto-unlocks on the same device', () => {
    directory = mkdtempSync(join(tmpdir(), 'lume-connection-vault-'))
    const path = join(directory, 'connection-vault.json')
    const createdKey = setupConnectionVault({ path, password: 'correct horse', safeStorage })
    const unlockedKey = autoUnlockConnectionVault({ path, safeStorage })
    const passwordUnlockedKey = unlockConnectionVaultWithPassword({ path, password: 'correct horse' })

    expect(getConnectionVaultStatus({ path, safeStorage })).toEqual({
      configured: true,
      secureStorageAvailable: true,
    })
    expect(unlockedKey).toEqual(createdKey)
    expect(passwordUnlockedKey).toEqual(createdKey)
    expect(verifyConnectionVaultPassword({ path, password: 'correct horse' })).toBe(true)
    expect(verifyConnectionVaultPassword({ path, password: 'wrong password' })).toBe(false)
    expect(() => setupConnectionVault({ path, password: 'another password', safeStorage }))
      .toThrow('connection_vault_already_configured')
    expect(() => unlockConnectionVaultWithPassword({ path, password: 'wrong password' }))
      .toThrow('connection_vault_password_invalid')

    createdKey.fill(0)
    unlockedKey?.fill(0)
    passwordUnlockedKey.fill(0)
  })

  test('refuses weak storage instead of falling back to plaintext', () => {
    directory = mkdtempSync(join(tmpdir(), 'lume-connection-vault-'))
    const path = join(directory, 'connection-vault.json')
    expect(() => setupConnectionVault({
      path,
      password: 'correct horse',
      safeStorage: { ...safeStorage, getSelectedStorageBackend: () => 'basic_text' },
    })).toThrow('connection_vault_secure_storage_unavailable')
  })
})
