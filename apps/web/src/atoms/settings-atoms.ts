import { atom } from 'jotai'
import { GENERAL_SETTINGS_DEFAULTS, type GeneralSettings } from '@lume/shared'
import type { SettingsTab } from './tab-atoms'

export const settingsActiveTabAtom = atom<SettingsTab>('channel')

/** 全局通用设置；在 Agent 视图启动时加载一次，渲染层据此决定显示模式。 */
export const generalSettingsAtom = atom<GeneralSettings>(GENERAL_SETTINGS_DEFAULTS)
