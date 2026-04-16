import { atom } from 'jotai'
import type { SettingsTab } from './tab-atoms'

export const settingsActiveTabAtom = atom<SettingsTab>('channel')
