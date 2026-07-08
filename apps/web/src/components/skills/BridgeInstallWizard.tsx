import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { bridgeWizardOpenAtom, bridgeWizardPluginAtom } from '@/atoms'
import {
  checkBridgeStatus,
  downloadBridgeAsset,
  exportPluginArtifact,
  getMarketDetail,
  installMarketItem,
  writeClipboardText,
} from '@/lib/desktop-api'
import type { PluginSetupArtifact, PluginSetupVerify } from '@lume/shared'
import { formatRiskLabel } from './plugin-detail-state'

interface BridgeInstallWizardProps {
  workspaceSlug: string | null
}

interface StepState {
  done: boolean
  checking: boolean
  note?: string
}

export function BridgeInstallWizard({ workspaceSlug }: BridgeInstallWizardProps) {
  const [open, setOpen] = useAtom(bridgeWizardOpenAtom)
  const plugin = useAtomValue(bridgeWizardPluginAtom)
  const setBridgeWizardPlugin = useSetAtom(bridgeWizardPluginAtom)
  const [index, setIndex] = useState(0)
  const [steps, setSteps] = useState<Record<string, StepState>>({})
  const [installing, setInstalling] = useState(false)

  useEffect(() => {
    if (open) {
      setIndex(0)
      setSteps({})
    }
  }, [open])

  const setupItems = useMemo(() => (plugin?.marketplace?.setup ?? []), [plugin])
  if (!plugin) return null

  const totalSteps = setupItems.length + 1 // +1 为 Lume 插件安装首步
  const current = setupItems[index - 1] // index 0 = 安装插件步

  const close = () => setOpen(false)

  const handleInstallPlugin = async () => {
    if (!workspaceSlug) {
      toast.error('未选择工作区，无法安装')
      return
    }
    if (plugin.installState === 'installed') {
      setIndex(1)
      return
    }
    setInstalling(true)
    try {
      const detail = await getMarketDetail({ workspaceSlug, kind: 'plugin', itemId: plugin.id })
      const inspect = detail.inspect?.kind === 'plugin' ? detail.inspect : null
      if (!inspect) {
        toast.error('无法获取插件权限信息')
        return
      }
      await installMarketItem({
        workspaceSlug,
        kind: 'plugin',
        itemId: plugin.id,
        acceptedPermissionsHash: inspect.permissionsHash,
        enableScope: 'workspace',
        overwrite: false,
      })
      const refreshed = await getMarketDetail({ workspaceSlug, kind: 'plugin', itemId: plugin.id })
      if (refreshed.item.kind === 'plugin') {
        setBridgeWizardPlugin(refreshed.item.plugin)
      }
      toast.success('安装成功')
      setIndex(1)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setInstalling(false)
    }
  }

  const handleExport = async (artifact: PluginSetupArtifact) => {
    try {
      const r = await exportPluginArtifact({
        pluginId: plugin.pluginId,
        version: plugin.version,
        artifactPath: artifact.path,
      })
      toast.success(`已导出到 ${r.savedPath}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const handleDownload = async (url: string, filename?: string) => {
    try {
      const r = await downloadBridgeAsset({ url, filename })
      toast.success(`已下载到 ${r.savedPath}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const handleVerify = async (stepId: string, verify: PluginSetupVerify) => {
    setSteps((s) => ({ ...s, [stepId]: { ...s[stepId], checking: true } }))
    try {
      const r = await checkBridgeStatus({
        pluginId: plugin.pluginId,
        version: plugin.version,
        verify,
      })
      setSteps((s) => ({ ...s, [stepId]: { done: r.ok, checking: false, note: r.detail } }))
    } catch (err) {
      setSteps((s) => ({ ...s, [stepId]: { done: false, checking: false, note: err instanceof Error ? err.message : String(err) } }))
    }
  }

  const markDone = (stepId: string) =>
    setSteps((s) => ({ ...s, [stepId]: { ...s[stepId], done: true } }))

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-[720px] lg:max-w-[880px] max-h-[88vh] overflow-y-auto" showCloseButton>
        <DialogHeader>
          <DialogTitle className="text-[16px] font-semibold text-[var(--text-1)]">
            安装向导：{plugin.displayName ?? plugin.name}
          </DialogTitle>
        </DialogHeader>

        <p className="text-[13px] text-[var(--text-2)]">步骤 {index + 1}/{totalSteps}</p>

        {index === 0 ? (
          <div className="lume-subpanel p-4">
            <h3 className="text-[14px] font-semibold">1. 安装 Lume 插件</h3>
            <p className="mt-2 text-[13px] text-[var(--text-2)]">
              {plugin.installState === 'installed'
                ? `已安装 v${plugin.version}，可继续完成桥接。`
                : '点击下方按钮完成 Lume 插件安装（含权限审查）。'}
            </p>
            {plugin.installState !== 'installed' && (
              <div className="mt-3">
                <p className="text-[12px] font-medium text-[var(--text-2)]">该插件申请的权限</p>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {plugin.permissions.riskLabels.length > 0 ? (
                    plugin.permissions.riskLabels.map((risk) => (
                      <span
                        key={risk}
                        className="inline-flex items-center rounded-4xl bg-[var(--surface-2)] px-2 py-0.5 text-[12px] font-medium text-[var(--text-1)]"
                      >
                        {formatRiskLabel(risk)}
                      </span>
                    ))
                  ) : (
                    <span className="inline-flex items-center rounded-4xl bg-[var(--surface-2)] px-2 py-0.5 text-[12px] font-medium text-[var(--text-2)]">
                      低风险
                    </span>
                  )}
                </div>
              </div>
            )}
            <div className="mt-3 flex gap-2">
              {plugin.installState === 'installed' ? (
                <Button onClick={() => setIndex(1)}>已安装，下一步</Button>
              ) : (
                <Button
                  onClick={handleInstallPlugin}
                  disabled={installing || !workspaceSlug}
                >
                  {installing ? '安装中…' : '确认权限并安装'}
                </Button>
              )}
            </div>
          </div>
        ) : current ? (
          <div className="lume-subpanel p-4">
            <h3 className="text-[14px] font-semibold">{index + 1}. {current.title}</h3>
            <p className="mt-2 text-[13px] text-[var(--text-2)]">{current.description}</p>
            {current.targetApp?.installHint && (
              <p className="mt-1 text-[12px] text-[var(--text-2)]">目标位置：{current.targetApp.installHint}</p>
            )}
            {current.build && (
              <div className="mt-2">
                <p className="text-[12px] text-[var(--text-2)]">{current.build.prerequisites}</p>
                <code className="mt-1 block rounded bg-[var(--surface-2)] p-2 text-[12px]">{current.build.command}</code>
                <Button variant="ghost" className="mt-1" onClick={() => writeClipboardText(current.build!.command)}>
                  复制命令
                </Button>
              </div>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              {current.artifact && (
                <Button onClick={() => handleExport(current.artifact!)}>导出 {artifactLabel(current.artifact.kind)}</Button>
              )}
              {current.download && (
                <Button onClick={() => handleDownload(current.download!.url, current.download!.filename)}>
                  下载 {current.download.filename ?? '资产'}
                </Button>
              )}
              {current.verify && current.verify.method !== 'none' && (
                <Button variant="ghost" disabled={steps[current.id]?.checking} onClick={() => handleVerify(current.id, current.verify!)}>
                  {steps[current.id]?.checking ? '检测中…' : '检测'}
                </Button>
              )}
              <Button variant="ghost" onClick={() => markDone(current.id)}>标记完成</Button>
            </div>
            {steps[current.id]?.note && (
              <p className="mt-2 text-[12px] text-[var(--text-2)]">{steps[current.id]?.note}</p>
            )}
          </div>
        ) : null}

        <div className="flex justify-between">
          <Button variant="ghost" disabled={index === 0} onClick={() => setIndex((i) => Math.max(0, i - 1))}>上一步</Button>
          {index < totalSteps - 1 ? (
            <Button onClick={() => setIndex((i) => i + 1)}>下一步</Button>
          ) : (
            <Button onClick={close}>完成</Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function artifactLabel(kind: PluginSetupArtifact['kind']): string {
  switch (kind) {
    case 'chrome-extension': return '扩展'
    case 'obsidian-plugin': return '插件'
    case 'native-binary': return '二进制'
    case 'node-bundle': return '脚本'
    default: return '产物'
  }
}
