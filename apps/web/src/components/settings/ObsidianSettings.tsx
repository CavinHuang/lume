/**
 * Obsidian Vault 集成设置：全局开关 + vault 候选列表（发现即授权）+
 * 手动添加 Markdown 文件夹。候选根会作为 agent 的环境目录权限。
 */

import { useCallback, useEffect, useState } from 'react'
import { FolderOpen, Loader2, Trash2 } from 'lucide-react'
import { ObsidianIcon } from '@/components/obsidian/obsidian-brand'
import { toast } from 'sonner'
import type { ObsidianVaultConfig } from '@lume/shared'
import {
  addObsidianFolderVault,
  createObsidianManagedVault,
  getObsidianVaultConfig,
  openFolderDialog,
  removeObsidianFolderVault,
  setObsidianVaultEnabled,
} from '@/lib/desktop-api'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'

export function ObsidianSettings() {
  const [config, setConfig] = useState<ObsidianVaultConfig | null>(null)
  const [busy, setBusy] = useState(false)

  const reload = useCallback(() => {
    void getObsidianVaultConfig()
      .then(setConfig)
      .catch((cause) => toast.error(cause instanceof Error ? cause.message : String(cause)))
  }, [])

  useEffect(() => { reload() }, [reload])

  const toggleEnabled = (enabled: boolean) => {
    setBusy(true)
    void setObsidianVaultEnabled(enabled)
      .then(reload)
      .then(() => toast.success(enabled ? '已开启 Obsidian Vault 集成' : '已关闭 Obsidian Vault 集成'))
      .catch((cause) => toast.error(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false))
  }

  const addFolder = () => {
    void openFolderDialog().then(async ({ path }) => {
      if (!path) return
      setBusy(true)
      try {
        setConfig(await addObsidianFolderVault(path))
        toast.success('已添加 Vault 文件夹')
      } catch (cause) {
        toast.error(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setBusy(false)
      }
    }).catch((cause) => toast.error(cause instanceof Error ? cause.message : String(cause)))
  }

  const createManaged = () => {
    setBusy(true)
    void createObsidianManagedVault()
      .then((next) => {
        setConfig(next)
        toast.success('已创建 Lume Vault')
      })
      .catch((cause) => toast.error(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false))
  }

  const removeFolder = (vaultPath: string) => {
    setBusy(true)
    void removeObsidianFolderVault(vaultPath)
      .then(reload)
      .catch((cause) => toast.error(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false))
  }

  const enabled = config?.enabled === true

  return (
    <section className="lume-panel">
      <div className="flex items-center gap-2.5 border-b border-[var(--border)] px-4 py-3">
        <div className="flex size-8 items-center justify-center rounded-[8px] bg-[color-mix(in_oklab,var(--brand)_10%,var(--surface-2))] text-[var(--brand)]">
          <ObsidianIcon size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-[14px] font-semibold text-[var(--text-1)]">Obsidian Vault</h3>
          <p className="text-[12px] text-[var(--text-3)]">发现的 Vault 自动对 Agent 可用（写操作仍走权限审批）</p>
        </div>
        <Switch checked={enabled} disabled={config === null || busy} onCheckedChange={toggleEnabled} aria-label="开启 Obsidian Vault 集成" />
      </div>
      <div className="px-4 py-3">
        {config === null ? (
          <div className="flex items-center gap-2 py-2 text-[12px] text-[var(--text-3)]">
            <Loader2 className="size-3.5 animate-spin" />加载中…
          </div>
        ) : config.candidates.length === 0 ? (
          <p className="py-1 text-[12px] text-[var(--text-3)]">
            未发现 Obsidian Vault；安装 Obsidian 并打开一次 vault，或手动添加 Markdown 文件夹。
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {config.candidates.map((vault) => (
              <li key={vault.path} className="flex items-center gap-2 rounded-[6px] border border-[var(--border)] px-2.5 py-1.5">
                <ObsidianIcon size={14} className="shrink-0 text-[var(--text-3)]" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12.5px] font-medium text-[var(--text-1)]">{vault.displayName}</p>
                  <p className="truncate text-[11px] text-[var(--text-3)]" title={vault.path}>{vault.path}</p>
                </div>
                <span className={cn(
                  'shrink-0 rounded-full px-2 py-0.5 text-[10px]',
                  vault.isObsidianVault
                    ? 'bg-[color-mix(in_oklab,var(--brand)_12%,transparent)] text-[var(--brand)]'
                    : 'bg-[var(--surface-2)] text-[var(--text-3)]',
                )}>
                  {vault.isObsidianVault ? 'Obsidian' : '文件夹'}
                </span>
                {vault.isManual && (
                  <Button variant="ghost" size="icon-sm" className="size-6" title="移除" disabled={busy} onClick={() => removeFolder(vault.path)}>
                    <Trash2 size={13} />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="mt-3 flex items-center justify-end gap-2">
          <Button variant="outline" size="sm" className="h-7 gap-1.5 text-[12px]" disabled={!enabled || busy} onClick={createManaged}>
            <ObsidianIcon size={13} />创建 Lume Vault
          </Button>
          <Button variant="outline" size="sm" className="h-7 gap-1.5 text-[12px]" disabled={!enabled || busy} onClick={addFolder}>
            <FolderOpen size={13} />添加文件夹
          </Button>
        </div>
      </div>
    </section>
  )
}
