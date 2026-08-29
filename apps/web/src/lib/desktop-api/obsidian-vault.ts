import { sidecarCall } from './system'
import {
  OBSIDIAN_VAULT_IPC_CHANNELS,
  type ObsidianVaultConfig,
  type ObsidianVaultFileEntry,
  type ObsidianVaultFocus,
  type ObsidianVaultReadResult,
  type ObsidianVaultWriteResult,
} from '@lume/shared'

export const getObsidianVaultConfig = () =>
  sidecarCall<ObsidianVaultConfig>(OBSIDIAN_VAULT_IPC_CHANNELS.GET_CONFIG)

export const setObsidianVaultEnabled = (enabled: boolean) =>
  sidecarCall<{ ok: true }>(OBSIDIAN_VAULT_IPC_CHANNELS.SET_ENABLED, { enabled })

export const addObsidianFolderVault = (vaultPath: string) =>
  sidecarCall<ObsidianVaultConfig>(OBSIDIAN_VAULT_IPC_CHANNELS.ADD_FOLDER_VAULT, { vaultPath })

export const removeObsidianFolderVault = (vaultPath: string) =>
  sidecarCall<{ ok: true }>(OBSIDIAN_VAULT_IPC_CHANNELS.REMOVE_FOLDER_VAULT, { vaultPath })

export const listObsidianVaultFiles = (vaultPath: string) =>
  sidecarCall<ObsidianVaultFileEntry[]>(OBSIDIAN_VAULT_IPC_CHANNELS.LIST_FILES, { vaultPath })

export const readObsidianVaultFile = (vaultPath: string, relativePath: string) =>
  sidecarCall<ObsidianVaultReadResult>(OBSIDIAN_VAULT_IPC_CHANNELS.READ_FILE, { vaultPath, relativePath })

export const writeObsidianVaultFile = (input: { vaultPath: string; relativePath: string; content: string; expectedSha256?: string }) =>
  sidecarCall<ObsidianVaultWriteResult>(OBSIDIAN_VAULT_IPC_CHANNELS.WRITE_FILE, input)

export const createObsidianVaultNote = (vaultPath: string, folderPath?: string) =>
  sidecarCall<ObsidianVaultWriteResult>(OBSIDIAN_VAULT_IPC_CHANNELS.CREATE_NOTE, { vaultPath, ...(folderPath ? { folderPath } : {}) })

export const createObsidianVaultFolder = (vaultPath: string, relativePath: string) =>
  sidecarCall<{ ok: true }>(OBSIDIAN_VAULT_IPC_CHANNELS.CREATE_FOLDER, { vaultPath, relativePath })

export const renameObsidianVaultFile = (input: { vaultPath: string; relativePath: string; name: string; expectedSha256?: string }) =>
  sidecarCall<ObsidianVaultReadResult>(OBSIDIAN_VAULT_IPC_CHANNELS.RENAME_FILE, input)

export const deleteObsidianVaultFile = (input: { vaultPath: string; relativePath: string; expectedSha256?: string }) =>
  sidecarCall<{ ok: true }>(OBSIDIAN_VAULT_IPC_CHANNELS.DELETE_FILE, input)

export const setObsidianVaultFocus = (threadId: string, vaultPath: string, focus: ObsidianVaultFocus | null) =>
  sidecarCall<{ ok: true }>(OBSIDIAN_VAULT_IPC_CHANNELS.SET_FOCUS, { threadId, vaultPath, focus })
