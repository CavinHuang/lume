import { describe, expect, test } from 'bun:test'
import rootPackage from '../../../../package.json'
import { APP_VERSION } from './app-version'

describe('app version', () => {
  test('uses the release version from the root package metadata', () => {
    expect(APP_VERSION).toBe(rootPackage.version)
    expect(APP_VERSION).not.toBe('0.1.0')
  })
})
