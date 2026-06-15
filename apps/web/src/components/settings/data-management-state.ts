import type { DataCleanupKey } from '@lume/shared'

export type CleanupSelection = Record<DataCleanupKey, boolean>

export interface CleanupOption {
  key: DataCleanupKey
  label: string
  desc: string
  rebuildable: boolean
}

export const CLEANUP_OPTIONS: CleanupOption[] = [
  {
    key: 'frontendTemp',
    label: '前端临时缓存',
    desc: '界面临时文件与 sessionStorage',
    rebuildable: true,
  },
  {
    key: 'previewRender',
    label: '预览/渲染缓存',
    desc: '预览图、渲染结果等可重建内容',
    rebuildable: true,
  },
  {
    key: 'logs',
    label: '日志缓存',
    desc: '本地日志文件，不影响配置和会话',
    rebuildable: true,
  },
  {
    key: 'vectorIndex',
    label: '向量索引',
    desc: '记忆向量索引，下次召回自动重建',
    rebuildable: true,
  },
  {
    key: 'pluginsCache',
    label: '插件缓存',
    desc: 'plugins/cache 与 plugins/data',
    rebuildable: true,
  },
]

export function createDefaultCleanupSelection(): CleanupSelection {
  return {
    frontendTemp: true,
    previewRender: true,
    logs: true,
    vectorIndex: true,
    pluginsCache: true,
  }
}

export function hasSelectedCleanup(selection: CleanupSelection): boolean {
  return Object.values(selection).some(Boolean)
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const value = bytes / Math.pow(1024, i)
  return `${i === 0 ? value : value.toFixed(1)} ${units[i]}`
}
