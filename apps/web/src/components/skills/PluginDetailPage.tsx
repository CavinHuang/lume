import { XMarkdown } from '@ant-design/x-markdown'
import {
  ArrowLeft,
  CheckCircle2,
  ExternalLink,
  Loader2,
  MoreHorizontal,
  Power,
  Puzzle,
  ShieldCheck,
  Trash2,
} from 'lucide-react'
import type { ReactNode } from 'react'
import type { GetMarketDetailResult } from '@lume/shared'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import { PLUGIN_SOURCE_LABELS } from './plugin-market-ui-state'
import {
  buildPermissionRows,
  buildPluginSetupItems,
  formatPluginEnableState,
  formatPluginInstallState,
  formatReadmeMeta,
  formatRiskLabel,
} from './plugin-detail-state'

export interface PluginDetailPageProps {
  detail: GetMarketDetailResult | null
  loading: boolean
  error: string | null
  busy: boolean
  onBack: () => void
  onInstall: () => void
  onUninstall: () => void
  onToggleEnable: () => void
  onTryInChat: () => void
}

export function PluginDetailPage({
  detail,
  loading,
  error,
  busy,
  onBack,
  onInstall,
  onUninstall,
  onToggleEnable,
  onTryInChat,
}: PluginDetailPageProps) {
  const item = detail?.item.kind === 'plugin' ? detail.item.plugin : null
  const inspected = detail?.inspect?.kind === 'plugin' ? detail.inspect : null
  const readme = detail?.readme
  const pluginName = item?.displayName ?? item?.name ?? '插件详情'
  const permissionRows = item ? buildPermissionRows(item) : []
  const setupItems = item ? buildPluginSetupItems(item) : []
  const diagnostics = item ? [...(detail?.diagnostics ?? []), ...(item.diagnostics ?? [])] : []
  const installed = item?.installState === 'installed'
  const enabled = item?.enableState === 'global-enabled' || item?.enableState === 'workspace-enabled'
  const canInstall = Boolean(item && inspected && !installed)

  return (
    <div className="h-full min-h-0 overflow-y-auto bg-[var(--background)]">
      <main className="mx-auto w-full max-w-[920px] px-5 py-6 sm:px-6 lg:px-8">
        <div className="mb-6 flex items-center gap-2 text-[13px] text-[var(--text-3)]">
          <Button
            variant="ghost"
            type="button"
            onClick={onBack}
            className="h-8 gap-2 rounded-[8px] px-2 text-[13px] text-[var(--text-2)]"
          >
            <ArrowLeft size={15} />
            插件
          </Button>
          <span>/</span>
          <span className="min-w-0 truncate text-[var(--text-1)]">{pluginName}</span>
        </div>

        {loading ? (
          <div className="flex min-h-[320px] items-center justify-center gap-2 text-[13px] text-[var(--text-3)]">
            <Loader2 size={16} className="animate-spin" />
            正在读取插件详情...
          </div>
        ) : error && !item ? (
          <section className="rounded-[8px] border border-[color:color-mix(in_oklab,var(--lume-danger)_28%,var(--border))] bg-[color:color-mix(in_oklab,var(--lume-danger)_7%,var(--surface-1))] p-5 text-[13px] leading-6 text-[var(--lume-danger)]">
            {error}
          </section>
        ) : item ? (
          <div className="space-y-6">
            <header className="space-y-4">
              <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-start">
                <div className="min-w-0">
                  <div className="mb-4 flex size-12 items-center justify-center rounded-[8px] border border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-1)]">
                    <Puzzle size={24} />
                  </div>
                  <h1 className="truncate text-[26px] font-semibold leading-8 text-[var(--text-1)]">{pluginName}</h1>
                  <p className="mt-2 max-w-[680px] text-[14px] leading-6 text-[var(--text-2)]">
                    {item.description ?? '暂无描述。'}
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2 md:justify-end">
                  <Button
                    variant="ghost"
                    size="icon"
                    type="button"
                    title="更多操作"
                    className="rounded-[8px] text-[var(--text-3)]"
                  >
                    <MoreHorizontal size={18} />
                  </Button>
                  {installed ? (
                    <Button
                      type="button"
                      disabled={busy}
                      onClick={onTryInChat}
                      className="h-9 gap-2 rounded-[8px] px-4 text-[13px] font-semibold"
                    >
                      <ExternalLink size={15} />
                      在对话中试用
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      disabled={!canInstall || busy}
                      onClick={onInstall}
                      className="h-9 gap-2 rounded-[8px] px-4 text-[13px] font-semibold"
                    >
                      {busy ? <Loader2 size={15} className="animate-spin" /> : <Power size={15} />}
                      {item.installState === 'update-available' ? '确认权限并更新' : '确认权限并安装'}
                    </Button>
                  )}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Badge>{PLUGIN_SOURCE_LABELS[item.sourceType]}</Badge>
                <Badge>{formatPluginInstallState(item.installState)}</Badge>
                <Badge>{formatPluginEnableState(item.enableState)}</Badge>
                <Badge>v{item.version}</Badge>
              </div>
            </header>

            <section className="lume-subpanel px-4 py-3 text-[13px] leading-6 text-[var(--text-2)]">
              <span className="font-semibold text-[var(--text-1)]">{pluginName}</span>
              <span> 的详情包含 README、Setup 和权限信息。</span>
            </section>

            {error && (
              <section className="rounded-[8px] bg-[color:color-mix(in_oklab,var(--lume-warning)_9%,var(--surface-1))] p-4 text-[13px] leading-6 text-[var(--lume-warning)]">
                {error}
              </section>
            )}

            <Tabs defaultValue="readme" className="gap-5">
              <TabsList variant="line" className="w-full justify-start border-b border-[var(--border)]">
                <TabsTrigger value="readme" className="max-w-none flex-none px-0 text-[14px]">
                  README
                </TabsTrigger>
                <TabsTrigger value="setup" className="max-w-none flex-none px-0 text-[14px]">
                  Setup
                </TabsTrigger>
                <TabsTrigger value="permissions" className="max-w-none flex-none px-0 text-[14px]">
                  权限
                </TabsTrigger>
                <TabsTrigger value="diagnostics" className="max-w-none flex-none px-0 text-[14px]">
                  诊断
                </TabsTrigger>
              </TabsList>

              <TabsContent value="readme">
                {readme ? (
                  <section className="space-y-3">
                    <div className="text-[12px] text-[var(--text-3)]">{formatReadmeMeta(readme)}</div>
                    <XMarkdown className="x-markdown text-[15px] leading-8 text-[var(--text-1)]">
                      {readme.markdown}
                    </XMarkdown>
                  </section>
                ) : (
                  <EmptyPanel title="未找到 README.md" description="该插件没有提供 README。" />
                )}
              </TabsContent>

              <TabsContent value="setup">
                <div className="space-y-3">
                  {setupItems.map((setup) => (
                    <div
                      key={setup.title}
                      className="flex gap-3 rounded-[8px] border border-[var(--border)] bg-[var(--surface-1)] p-4"
                    >
                      <CheckCircle2
                        size={18}
                        className={cn(
                          'mt-0.5 shrink-0',
                          setup.status === 'done'
                            ? 'text-[var(--lume-success)]'
                            : setup.status === 'attention'
                              ? 'text-[var(--lume-warning)]'
                              : 'text-[var(--text-3)]',
                        )}
                      />
                      <div className="min-w-0">
                        <div className="text-[13px] font-semibold text-[var(--text-1)]">{setup.title}</div>
                        <div className="mt-1 text-[12px] leading-5 text-[var(--text-3)]">{setup.description}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </TabsContent>

              <TabsContent value="permissions">
                <section className="space-y-4">
                  <div className="flex items-center gap-2 text-[14px] font-semibold text-[var(--text-1)]">
                    <ShieldCheck size={18} className="text-[var(--lume-success)]" />
                    权限审核
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {item.permissions.riskLabels.length > 0 ? (
                      item.permissions.riskLabels.map((risk) => (
                        <Badge key={risk} tone="warning">
                          {formatRiskLabel(risk)}
                        </Badge>
                      ))
                    ) : (
                      <Badge tone="success">低风险</Badge>
                    )}
                  </div>
                  <div className="space-y-3">
                    {permissionRows.map((row) => (
                      <div
                        key={row.label}
                        className="grid gap-2 rounded-[8px] bg-[var(--surface-2)] px-3 py-2 text-[12px] leading-5 md:grid-cols-[120px_minmax(0,1fr)]"
                      >
                        <span className="font-semibold text-[var(--text-1)]">{row.label}</span>
                        <span className="break-all text-[var(--text-2)]">{row.value}</span>
                      </div>
                    ))}
                  </div>
                  {inspected && (
                    <div className="rounded-[8px] bg-[var(--surface-2)] px-3 py-2 text-[12px] leading-5 text-[var(--text-2)]">
                      权限 hash：<span className="font-mono">{inspected.permissionsHash}</span>
                    </div>
                  )}
                </section>
              </TabsContent>

              <TabsContent value="diagnostics">
                {diagnostics.length > 0 ? (
                  <ul className="space-y-2 text-[13px] leading-6 text-[var(--lume-warning)]">
                    {diagnostics.map((diagnostic, index) => (
                      <li
                        key={`${diagnostic.code}-${index}`}
                        className="rounded-[8px] bg-[color:color-mix(in_oklab,var(--lume-warning)_9%,var(--surface-1))] p-3"
                      >
                        {diagnostic.message}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <EmptyPanel title="暂无诊断信息" description="当前插件未返回需要处理的问题。" />
                )}
              </TabsContent>
            </Tabs>

            {installed && (
              <div className="flex justify-end gap-2 border-t border-[var(--border)] pt-5">
                <Button
                  variant="ghost"
                  type="button"
                  disabled={busy}
                  onClick={onToggleEnable}
                  className="h-9 gap-2 rounded-[8px] border border-[var(--border)] px-4 text-[13px] font-semibold"
                >
                  <Power size={15} />
                  {enabled ? '禁用' : '启用'}
                </Button>
                <Button
                  variant="ghost"
                  type="button"
                  disabled={busy}
                  onClick={onUninstall}
                  className="h-9 gap-2 rounded-[8px] border border-[color:color-mix(in_oklab,var(--lume-danger)_32%,var(--border))] px-4 text-[13px] font-semibold text-[var(--lume-danger)]"
                >
                  <Trash2 size={15} />
                  卸载
                </Button>
              </div>
            )}
          </div>
        ) : (
          <EmptyPanel title="暂无插件详情" description="返回插件市场后重新选择一个插件。" />
        )}
      </main>
    </div>
  )
}

function Badge({ children, tone = 'default' }: { children: ReactNode; tone?: 'default' | 'warning' | 'success' }) {
  return (
    <span
      className={cn(
        'rounded-[5px] px-2 py-1 text-[12px] font-medium',
        tone === 'warning'
          ? 'bg-[color:color-mix(in_oklab,var(--lume-warning)_12%,var(--surface-1))] text-[var(--lume-warning)]'
          : tone === 'success'
            ? 'bg-[color:color-mix(in_oklab,var(--lume-success)_10%,var(--surface-1))] text-[var(--lume-success)]'
            : 'bg-[var(--surface-2)] text-[var(--text-2)]',
      )}
    >
      {children}
    </span>
  )
}

function EmptyPanel({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-[8px] border border-dashed border-[var(--border)] p-8 text-center">
      <div className="text-[14px] font-semibold text-[var(--text-1)]">{title}</div>
      <div className="mt-2 text-[13px] leading-6 text-[var(--text-3)]">{description}</div>
    </div>
  )
}
