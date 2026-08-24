import { describe, expect, test } from 'bun:test'
import {
  planVoiceShortcutSync,
  readVoiceDictationSettings,
  updateVoiceDictationSettings,
} from './voice-dictation-settings-service'
import type { VoiceDictationSettings } from '@lume/shared'
import { VOICE_DICTATION_DEFAULT_SHORTCUT } from '@lume/shared'

const COMPLETE = { appId: 'a', accessToken: 't', resourceId: 'r' }

describe('planVoiceShortcutSync', () => {
  test('registered A -> conflicting B registers B (caller rolls back on failure)', () => {
    const plan = planVoiceShortcutSync({
      credentialsComplete: true,
      desiredShortcut: 'Alt+K',
      currentRegisteredShortcut: 'CommandOrControl+Alt+V',
    })
    expect(plan).toEqual({ action: 'register', shortcut: 'Alt+K' })
  })

  test('unconfigured stays unregistered on unrelated setting changes', () => {
    const plan = planVoiceShortcutSync({
      credentialsComplete: false,
      desiredShortcut: 'CommandOrControl+Alt+V',
      currentRegisteredShortcut: '',
    })
    expect(plan).toEqual({ action: 'keep', shortcut: 'CommandOrControl+Alt+V' })
  })

  test('configured then cleared unregisters the leftover binding', () => {
    const plan = planVoiceShortcutSync({
      credentialsComplete: false,
      desiredShortcut: 'CommandOrControl+Alt+V',
      currentRegisteredShortcut: 'CommandOrControl+Alt+V',
    })
    expect(plan).toEqual({ action: 'unregister' })
  })

  test('same shortcut registered is a no-op keep', () => {
    const plan = planVoiceShortcutSync({
      credentialsComplete: true,
      desiredShortcut: 'Alt+K',
      currentRegisteredShortcut: 'Alt+K',
    })
    expect(plan).toEqual({ action: 'keep', shortcut: 'Alt+K' })
  })

  test('first-time registration with credentials goes straight to register', () => {
    const plan = planVoiceShortcutSync({
      credentialsComplete: true,
      desiredShortcut: 'CommandOrControl+Alt+V',
      currentRegisteredShortcut: '',
    })
    expect(plan).toEqual({ action: 'register', shortcut: 'CommandOrControl+Alt+V' })
  })
})

type BrokerLike = Parameters<typeof updateVoiceDictationSettings>[0]
type RootStore = Record<string, unknown>

interface MemoryBroker extends BrokerLike {
  read(): RootStore
}

function inMemoryBroker(): MemoryBroker {
  let store: RootStore = {}
  return {
    read: () => store,
    mutate: (fn: (prev: RootStore) => RootStore) => {
      store = fn(store)
      return store
    },
  } as unknown as MemoryBroker
}

describe('voice dictation settings coerce', () => {
  test('read fills defaults for empty store', () => {
    const settings = readVoiceDictationSettings(inMemoryBroker())
    expect(settings.shortcut).toBe(VOICE_DICTATION_DEFAULT_SHORTCUT)
    expect(settings.outputMode).toBe('lume-input')
    expect(settings.appId).toBe('')
  })

  test('update coerces non-string fields to defaults instead of persisting them', () => {
    const broker = inMemoryBroker()
    updateVoiceDictationSettings(broker, {
      appId: 42 as unknown as string,
      accessToken: { evil: true } as unknown as string,
      language: null as unknown as string,
      outputMode: 'nonsense' as unknown as VoiceDictationSettings['outputMode'],
      customHotwords: '热词',
      resourceId: 'r',
      shortcut: 'Ctrl+Shift+L',
    })
    const settings = readVoiceDictationSettings(broker)
    // 脏值回落，不落盘不清空既有凭证。
    expect(settings.appId).toBe('')
    expect(settings.accessToken).toBe('')
    expect(settings.language).toBe('')
    expect(settings.outputMode).toBe('lume-input')
    expect(settings.customHotwords).toBe('热词')
    expect(settings.resourceId).toBe('r')
    expect(settings.shortcut).toBe('Ctrl+Shift+L')
  })

  test('unknown extra keys in updates are not persisted', () => {
    const broker = inMemoryBroker()
    updateVoiceDictationSettings(broker, { appId: 'a', rogueKey: 'x' } as unknown as Parameters<typeof updateVoiceDictationSettings>[1])
    const stored = (broker.read() as { voiceDictation?: Record<string, unknown> }).voiceDictation ?? {}
    expect(Object.keys(stored).sort()).toEqual([
      'accessToken', 'appId', 'customHotwords', 'language', 'outputMode', 'resourceId', 'shortcut',
    ])
  })
})
