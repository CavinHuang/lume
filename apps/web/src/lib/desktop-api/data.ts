import { invoke } from '@/lib/desktop-runtime/core'
import { AGENT_IPC_CHANNELS, DATA_CATEGORY_SCAN_SPEC } from '@lume/shared'
import type {
  EmptyTrashResult,
  ExportZipInput,
  ExportZipResult,
  MigrationApplyInput,
  MigrationResult,
  StorageStats,
} from '@lume/shared'
import { sidecarCall } from './system'

// 桌面命令用下划线名（与 native.ts 既有 desktop_* 命令同风格，直接 invoke）
export const getStorageStats = () =>
  invoke<StorageStats>('data_get_storage_stats', { categories: DATA_CATEGORY_SCAN_SPEC })

export const exportZip = (input: ExportZipInput) =>
  invoke<ExportZipResult>('data_export_zip', { ...input })

export const emptyTrash = () =>
  sidecarCall<EmptyTrashResult>(AGENT_IPC_CHANNELS.EMPTY_TRASH, {})

export const migrateToDir = (dest: string) =>
  invoke<MigrationResult>('data_migrate_to_dir', { dest })

export const applyMigration = (input: MigrationApplyInput) =>
  invoke<{ ok: boolean }>('data_apply_migration', { ...input })
