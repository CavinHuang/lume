/**
 * Obsidian Vault 集成契约（移植自 Proma 的 vault 方案）：
 * Obsidian 全局注册表仅用于发现候选；磁盘上始终是普通 Markdown 文件，
 * 所有读写收敛在 sidecar 的受控 facade 内。
 */

export interface ObsidianVaultCandidate {
  path: string
  displayName: string
  /** 注册表条目旁存在 .obsidian 目录时为 true；手动添加的文件夹为 false。 */
  isObsidianVault: boolean
  /** extraVaults 中用户手动添加、非 Obsidian 注册表来源。 */
  isManual?: boolean
  /** Lume 托管 Vault（<configDir>/vaults/default），未装 Obsidian 的内置笔记库。 */
  isManaged?: boolean
}

export interface ObsidianVaultConfig {
  enabled: boolean
  candidates: ObsidianVaultCandidate[]
}

export interface ObsidianVaultFileEntry {
  relativePath: string
  name: string
  size: number
  modifiedAt: number
}

export interface ObsidianVaultReadResult {
  relativePath: string
  content: string
  sha256: string
  modifiedAt: number
}

export interface ObsidianVaultWriteInput {
  vaultPath: string
  relativePath: string
  content: string
  expectedSha256?: string
}

export type ObsidianVaultWriteResult =
  | { ok: true; relativePath: string; sha256: string; modifiedAt: number }
  | { ok: false; reason: "conflict"; currentSha256: string; currentModifiedAt: number }

export interface ObsidianVaultRenameInput {
  vaultPath: string
  relativePath: string
  name: string
  expectedSha256?: string
}

export interface ObsidianVaultDeleteInput {
  vaultPath: string
  relativePath: string
  expectedSha256?: string
}

/** 用户在右侧 Vault 面板中打开的位置。路径恒相对其授权根。 */
export interface ObsidianVaultFocus {
  kind: "file" | "folder"
  relativePath: string
  /** 每个 renderer 单调递增；sidecar 丢弃过期 focus，防止旧 IPC 覆盖新状态。 */
  sequence: number
}

/** 回合开始时用户聚焦的 Vault 位置，用于渲染回复后的 Obsidian 上下文 chip。 */
export interface ObsidianVaultFocusAttribution {
  vaultPath: string
  displayName: string
  focus: ObsidianVaultFocus
}

export const OBSIDIAN_VAULT_IPC_CHANNELS = {
  GET_CONFIG: "obsidian:get-config",
  SET_ENABLED: "obsidian:set-enabled",
  ADD_FOLDER_VAULT: "obsidian:add-folder-vault",
  REMOVE_FOLDER_VAULT: "obsidian:remove-folder-vault",
  CREATE_MANAGED_VAULT: "obsidian:create-managed-vault",
  LIST_FILES: "obsidian:list-files",
  READ_FILE: "obsidian:read-file",
  WRITE_FILE: "obsidian:write-file",
  CREATE_NOTE: "obsidian:create-note",
  CREATE_FOLDER: "obsidian:create-folder",
  RENAME_FILE: "obsidian:rename-file",
  DELETE_FILE: "obsidian:delete-file",
  SET_FOCUS: "obsidian:set-focus",
} as const
