import { atom } from 'jotai'
import type { ObsidianVaultReadResult } from '@lume/shared'

/**
 * 跨组件打开 Vault 位置的请求通道（回合 chip → 面板）。
 * token 由发送方递增，面板据此去重消费。
 */
export interface ObsidianVaultOpenRequest {
  vaultPath: string
  filePath?: string
  folderPath?: string
  token: number
}

export const obsidianVaultOpenRequestAtom = atom<ObsidianVaultOpenRequest | null>(null)

/** 打开中的笔记状态快照，供全页 tab 与右面板之间切换时恢复（Proma 的全局 atoms 语义）。 */
export interface ObsidianVaultEditorSnapshot {
  vaultPath: string
  selectedFile: { path: string; read: ObsidianVaultReadResult } | null
  draft: string
}

export const obsidianVaultEditorAtom = atom<ObsidianVaultEditorSnapshot>({ vaultPath: '', selectedFile: null, draft: '' })
