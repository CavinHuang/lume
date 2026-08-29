import { atom } from 'jotai'

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
