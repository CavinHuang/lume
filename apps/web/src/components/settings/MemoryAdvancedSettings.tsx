import * as React from 'react'
import { Download, RefreshCw, SearchCheck, ShieldCheck } from 'lucide-react'
import { useAtomValue } from 'jotai'
import { toast } from 'sonner'
import type {
  MemoryCitationsMode,
  MemoryDiagnosticsSnapshot,
  MemoryRuntimeConfig,
} from '@lume/shared'
import { agentWorkspacesAtom, currentWorkspaceIdAtom, memoryCenterVersionAtom } from '@/atoms'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import {
  cancelMemoryJob,
  getMemoryDiagnosticsSnapshot,
  getMemoryRuntimeConfig,
  openMemorySource,
  reloadLocalOnnxEmbedding,
  retryMemoryJob,
  updateMemoryRuntimeConfig,
} from '@/lib/desktop-api'
import { cn } from '@/lib/utils'
import {
  MEMORY_CITATION_MODE_LABELS,
  MEMORY_TOOL_POLICY_GROUPS,
  isMemoryToolGroupEnabled,
  localOnnxStatusLabel,
  localOnnxStatusTone,
  setMemoryToolGroupEnabled,
  summarizeLocalOnnxStatus,
  type MemoryToolPolicyGroupId,
} from './memory-settings-state'

/** 记忆设置只读取轻量诊断投影，不加载条目、待处理或活动数据。 */
export function MemoryAdvancedSettings() {
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const currentWorkspaceId = useAtomValue(currentWorkspaceIdAtom)
  const memoryCenterVersion = useAtomValue(memoryCenterVersionAtom)
  const workspace = React.useMemo(
    () => workspaces.find((item) => item.id === currentWorkspaceId) ?? workspaces[0] ?? null,
    [currentWorkspaceId, workspaces],
  )
  const workspaceSlug = workspace?.slug ?? null
  const [runtimeConfig, setRuntimeConfig] = React.useState<MemoryRuntimeConfig | null>(null)
  const [diagnostics, setDiagnostics] = React.useState<MemoryDiagnosticsSnapshot | null>(null)
  const [busyAction, setBusyAction] = React.useState<string | null>(null)

  const refresh = React.useCallback(async () => {
    if (!workspaceSlug) return
    try {
      const { runtimeConfig: nextConfig, diagnostics: nextDiagnostics } = await loadMemoryAdvancedSettings(workspaceSlug)
      setRuntimeConfig(nextConfig)
      setDiagnostics(nextDiagnostics)
    } catch (error) {
      console.error('[MemoryAdvancedSettings] refresh FAILED:', error)
      toast.error(errorMessage(error, '读取记忆设置失败'))
    }
  }, [workspaceSlug])

  React.useEffect(() => {
    void refresh()
  }, [memoryCenterVersion, refresh])

  React.useEffect(() => {
    if (!diagnostics?.jobs.some((job) => job.status === 'queued' || job.status === 'running')) return undefined
    const timer = window.setTimeout(() => void refresh(), 1200)
    return () => window.clearTimeout(timer)
  }, [diagnostics?.jobs, refresh])

  React.useEffect(() => {
    const status = diagnostics?.retrieval.semantic.localOnnx?.status
    if (status !== 'downloading' && status !== 'initializing') return undefined
    const timer = window.setTimeout(() => void refresh(), 1500)
    return () => window.clearTimeout(timer)
  }, [diagnostics?.retrieval.semantic.localOnnx?.status, refresh])

  const runAction = async (name: string, action: () => Promise<void>) => {
    setBusyAction(name)
    try {
      await action()
    } catch (error) {
      console.error(`[MemoryAdvancedSettings] ${name} FAILED:`, error)
      toast.error(errorMessage(error, '记忆设置操作失败'))
    } finally {
      setBusyAction(null)
    }
  }

  const updateConfig = (name: string, patch: Partial<MemoryRuntimeConfig>) => runAction(name, async () => {
    setRuntimeConfig(await updateMemoryRuntimeConfig(patch))
  })

  const handleTogglePolicyGroup = (groupId: MemoryToolPolicyGroupId, enabled: boolean) => {
    if (!runtimeConfig) return
    void updateConfig(`policy-${groupId}`, {
      tools: setMemoryToolGroupEnabled(runtimeConfig, groupId, enabled),
    })
  }

  const handleCitationsMode = (citations: MemoryCitationsMode) => {
    void updateConfig(`citations-${citations}`, { citations })
  }

  const handleSemanticMode = (semantic: MemoryRuntimeConfig['retrieval']['semantic']) => {
    if (!runtimeConfig) return
    void runAction(`semantic-${semantic}`, async () => {
      setRuntimeConfig(await updateMemoryRuntimeConfig({
        retrieval: { ...runtimeConfig.retrieval, semantic },
      }))
      await refresh()
    })
  }

  const handleCancelJob = (jobId: string) => runAction(`cancel-job-${jobId}`, async () => {
    if (!workspaceSlug) return
    await cancelMemoryJob({ workspaceSlug, jobId })
    await refresh()
  })

  const handleRetryJob = (jobId: string) => runAction(`retry-job-${jobId}`, async () => {
    if (!workspaceSlug) return
    await retryMemoryJob({ workspaceSlug, jobId })
    await refresh()
  })

  if (!workspaceSlug) {
    return (
      <section className="lume-panel p-4">
        <h2 className="text-[14px] font-semibold text-[var(--text-1)]">暂无工作区</h2>
        <p className="mt-1 text-[12px] text-[var(--text-3)]">创建或选择一个工作区后即可管理记忆设置。</p>
      </section>
    )
  }

  const localOnnx = diagnostics?.retrieval.semantic.localOnnx
  const activeJobs = diagnostics?.jobs.filter((job) => job.status === 'queued' || job.status === 'running') ?? []

  return (
    <section className="lume-panel p-4" data-memory-advanced-settings>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[14px] font-semibold text-[var(--text-1)]">记忆设置</h2>
          <p className="mt-1 text-[12px] leading-5 text-[var(--text-3)]">
            管理主动记忆、后台整理、召回与迁移诊断。
          </p>
        </div>
        <Button variant="outline" size="sm" disabled={busyAction !== null} onClick={() => void refresh()}>
          <RefreshCw size={14} />
          刷新
        </Button>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
        {MEMORY_TOOL_POLICY_GROUPS.map((group) => {
          const checked = isMemoryToolGroupEnabled(runtimeConfig?.tools, group.id)
          return (
            <label
              key={group.id}
              className={cn(
                'flex min-h-[76px] items-center justify-between gap-3 rounded-[8px] border p-3',
                checked
                  ? 'border-[color-mix(in_oklab,var(--brand)_35%,var(--border))] bg-[color-mix(in_oklab,var(--brand)_8%,var(--surface-1))]'
                  : 'lume-subpanel',
              )}
            >
              <span className="min-w-0">
                <span className="text-[13px] font-semibold text-[var(--text-1)]">{group.label}</span>
                <span className="mt-1 block text-[12px] leading-5 text-[var(--text-3)]">{group.desc}</span>
              </span>
              <Switch
                checked={checked}
                disabled={!runtimeConfig || busyAction !== null}
                onCheckedChange={(enabled) => handleTogglePolicyGroup(group.id, enabled)}
              />
            </label>
          )
        })}
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
        {([
          ['proactiveWrite', '主 Agent 主动记忆', '私聊中发现稳定信息时立即记住。'],
          ['backgroundExtraction', '后台自动提取', '回答完成后异步检查遗漏的稳定记忆。'],
          ['autoDream', 'AutoDream', '满足 24 小时和 5 个会话门槛后自动整理。'],
        ] as const).map(([key, label, desc]) => (
          <label key={key} className="lume-subpanel flex min-h-[84px] items-center justify-between gap-3 p-3">
            <span>
              <span className="text-[13px] font-semibold text-[var(--text-1)]">{label}</span>
              <span className="mt-1 block text-[12px] leading-5 text-[var(--text-3)]">{desc}</span>
            </span>
            <Switch
              checked={runtimeConfig?.[key] ?? true}
              disabled={!runtimeConfig || busyAction !== null}
              onCheckedChange={(enabled) => void updateConfig(`automation-${key}`, { [key]: enabled })}
            />
          </label>
        ))}
      </div>

      <div className="lume-subpanel mt-4 flex flex-wrap items-center justify-between gap-3 p-3">
        <div className="flex items-center gap-2 text-[13px] font-semibold text-[var(--text-1)]">
          <ShieldCheck size={15} />
          回复下方引用
        </div>
        <div className="lume-segmented flex">
          {(['auto', 'on', 'off'] as const).map((mode) => (
            <Button
              key={mode}
              variant="ghost"
              disabled={!runtimeConfig || busyAction !== null}
              onClick={() => handleCitationsMode(mode)}
              className={cn('lume-segmented-item px-2 text-[12px]', runtimeConfig?.citations === mode && 'lume-segmented-item-active')}
            >
              {MEMORY_CITATION_MODE_LABELS[mode]}
            </Button>
          ))}
        </div>
      </div>

      <div className="lume-subpanel mt-4 p-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-[13px] font-semibold text-[var(--text-1)]">
              <SearchCheck size={15} />
              语义召回
            </div>
            <p className="mt-1 text-[12px] leading-5 text-[var(--text-3)]">
              {diagnostics?.retrieval.semantic.message ?? '基础召回可用'}
            </p>
          </div>
          <div className="lume-segmented flex">
            {(['auto', 'off'] as const).map((mode) => (
              <Button
                key={mode}
                variant="ghost"
                disabled={!runtimeConfig || busyAction !== null}
                onClick={() => handleSemanticMode(mode)}
                className={cn('lume-segmented-item px-2 text-[12px]', runtimeConfig?.retrieval.semantic === mode && 'lume-segmented-item-active')}
              >
                {mode === 'auto' ? '自动' : '关闭'}
              </Button>
            ))}
          </div>
        </div>
        {localOnnx && (
          <div className="mt-3 border-t border-border pt-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-[12px] font-semibold text-[var(--text-1)]">
                <Download size={14} />
                本地 ONNX
              </div>
              <span className={cn(
                'rounded-[6px] px-2 py-0.5 text-[11px] font-medium',
                localOnnxStatusTone(localOnnx.status) === 'good' && 'bg-emerald-500/10 text-emerald-600',
                localOnnxStatusTone(localOnnx.status) === 'warn' && 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
                localOnnxStatusTone(localOnnx.status) === 'neutral' && 'bg-[var(--surface-2)] text-[var(--text-3)]',
              )}>
                {localOnnxStatusLabel(localOnnx.status)}
              </span>
            </div>
            <p className="mt-2 text-[12px] leading-5 text-[var(--text-3)]">{summarizeLocalOnnxStatus(localOnnx)}</p>
            {(localOnnx.status === 'not_cached' || localOnnx.status === 'failed') && (
              <Button
                className="mt-2"
                variant="outline"
                size="sm"
                disabled={busyAction !== null}
                onClick={() => void runAction('reload-local-onnx', async () => {
                  await reloadLocalOnnxEmbedding()
                  await refresh()
                })}
              >
                <RefreshCw size={14} className={busyAction === 'reload-local-onnx' ? 'animate-spin' : undefined} />
                {busyAction === 'reload-local-onnx' ? '加载中' : localOnnx.status === 'not_cached' ? '下载模型' : '重新加载'}
              </Button>
            )}
          </div>
        )}
      </div>

      {activeJobs.length > 0 && (
        <div className="lume-subpanel mt-4 space-y-2 p-3">
          <div className="text-[12px] font-semibold text-[var(--text-2)]">正在运行的后台任务</div>
          {activeJobs.map((job) => (
            <div key={job.jobId} className="flex flex-wrap items-center justify-between gap-2 text-[12px]">
              <span>{job.kind} · {job.status}</span>
              <Button variant="outline" size="sm" disabled={busyAction !== null} onClick={() => void handleCancelJob(job.jobId)}>停止</Button>
            </div>
          ))}
        </div>
      )}

      <div className="lume-subpanel mt-4 grid gap-3 p-3 text-[12px] text-[var(--text-3)] md:grid-cols-3">
        <div>
          <div className="font-semibold text-[var(--text-2)]">迁移版本</div>
          <div className="mt-1">Memory Schema v{diagnostics?.migration.schemaVersion ?? '未知'}</div>
        </div>
        <div>
          <div className="font-semibold text-[var(--text-2)]">最近后台任务</div>
          <div className="mt-1">{diagnostics?.jobs[0] ? `${diagnostics.jobs[0].kind} · ${diagnostics.jobs[0].status}` : '暂无任务'}</div>
          {diagnostics?.jobs[0]?.retryable && (
            <Button variant="ghost" size="sm" className="mt-1 h-auto px-0" onClick={() => void handleRetryJob(diagnostics.jobs[0]!.jobId)}>
              重试中断任务
            </Button>
          )}
        </div>
        <div>
          <div className="font-semibold text-[var(--text-2)]">迁移备份</div>
          {diagnostics?.migration.backupPaths[0] ? (
            <Button
              variant="ghost"
              size="sm"
              className="mt-1 h-auto px-0"
              onClick={() => void runAction('open-backup', async () => {
                await openMemorySource({ workspaceSlug, path: diagnostics.migration.backupPaths[0]! })
              })}
            >
              打开最近备份
            </Button>
          ) : <div className="mt-1">无需迁移或暂无备份</div>}
        </div>
      </div>
    </section>
  )
}

export async function loadMemoryAdvancedSettings(
  workspaceSlug: string,
  loaders: {
    runtimeConfig: () => Promise<MemoryRuntimeConfig>
    diagnostics: (workspaceSlug: string) => Promise<MemoryDiagnosticsSnapshot>
  } = {
    runtimeConfig: getMemoryRuntimeConfig,
    diagnostics: getMemoryDiagnosticsSnapshot,
  },
): Promise<{ runtimeConfig: MemoryRuntimeConfig; diagnostics: MemoryDiagnosticsSnapshot }> {
  const [runtimeConfig, diagnostics] = await Promise.all([
    loaders.runtimeConfig(),
    loaders.diagnostics(workspaceSlug),
  ])
  return { runtimeConfig, diagnostics }
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}
