import { XMarkdown } from '@ant-design/x-markdown'
import {
  ArrowLeft,
  CheckCircle2,
  ExternalLink,
  Loader2,
  Power,
  Puzzle,
  ShieldCheck,
  Trash2,
} from 'lucide-react'
import type { ReactNode } from 'react'
import type { GetMarketDetailResult, PluginMarketplaceAsset } from '@lume/shared'
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

type PluginDiagnostic = GetMarketDetailResult['diagnostics'][number]

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
  const diagnostics = item ? dedupeDiagnostics(detail?.diagnostics, item.diagnostics) : []
  const installState = inspected?.installState ?? item?.installState ?? 'not-installed'
  const enableState = inspected?.enableState ?? item?.enableState ?? 'not-installed'
  const effectiveItem = item ? { ...item, installState, enableState } : null
  const setupItems = effectiveItem ? buildPluginSetupItems(effectiveItem) : []
  const marketplace = item?.marketplace
  const marketplaceMedia = marketplace?.hero ?? marketplace?.thumbnail
  const marketplaceWebsite = safeExternalUrl(marketplace?.website)
  const installedLike = installState === 'installed' || installState === 'update-available'
  const updateAvailable = installState === 'update-available'
  const enabled = enableState === 'global-enabled' || enableState === 'workspace-enabled'
  const canInstall = Boolean(item && inspected && !installedLike)
  const canUpdate = Boolean(item && inspected && updateAvailable)

  return (
    <div
      data-plugin-detail-shell="full-width"
      className="h-full min-h-0 min-w-0 flex-1 overflow-y-auto bg-[var(--background)]"
    >
      <main className="mx-auto w-full max-w-[1230px] px-5 py-6 sm:px-6 lg:px-8">
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
          <div role="status" className="flex min-h-[320px] items-center justify-center gap-2 text-[13px] text-[var(--text-3)]">
            <Loader2 size={16} className="animate-spin" />
            正在读取插件详情...
          </div>
        ) : error && !item ? (
          <section role="alert" className="rounded-[8px] border border-[color:color-mix(in_oklab,var(--lume-danger)_28%,var(--border))] bg-[color:color-mix(in_oklab,var(--lume-danger)_7%,var(--surface-1))] p-5 text-[13px] leading-6 text-[var(--lume-danger)]">
            {error}
          </section>
        ) : item ? (
          <div className="space-y-6">
            <header className="space-y-4">
              <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-start">
                <div className="min-w-0">
                  <div className="mb-4 flex size-12 items-center justify-center overflow-hidden rounded-[8px] border border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-1)]">
                    {marketplace?.icon?.url ? (
                      <img
                        src={marketplace.icon.url}
                        alt=""
                        data-plugin-marketplace-icon="true"
                        className="size-full object-cover"
                      />
                    ) : (
                      <Puzzle size={24} />
                    )}
                  </div>
                  <h1 className="truncate text-[26px] font-semibold leading-8 text-[var(--text-1)]">{pluginName}</h1>
                  <p className="mt-2 max-w-[680px] text-[14px] leading-6 text-[var(--text-2)]">
                    {item.description ?? '暂无描述。'}
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2 md:justify-end">
                  {updateAvailable ? (
                    <Button
                      type="button"
                      disabled={!canUpdate || busy}
                      onClick={onInstall}
                      data-plugin-detail-install-action={canUpdate && !busy ? 'enabled' : 'disabled'}
                      className="h-9 gap-2 rounded-[8px] px-4 text-[13px] font-semibold"
                    >
                      {busy ? <Loader2 size={15} className="animate-spin" /> : <Power size={15} />}
                      确认权限并更新
                    </Button>
                  ) : installedLike && enabled ? (
                    <Button
                      type="button"
                      disabled={busy}
                      onClick={onTryInChat}
                      data-plugin-detail-header-action="try"
                      className="h-9 gap-2 rounded-[8px] px-4 text-[13px] font-semibold"
                    >
                      <ExternalLink size={15} />
                      在对话中试用
                    </Button>
                  ) : installedLike ? (
                    <Button
                      type="button"
                      disabled={busy}
                      onClick={onToggleEnable}
                      data-plugin-detail-header-action="enable"
                      className="h-9 gap-2 rounded-[8px] px-4 text-[13px] font-semibold"
                    >
                      <Power size={15} />
                      启用
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      disabled={!canInstall || busy}
                      onClick={onInstall}
                      data-plugin-detail-install-action={canInstall && !busy ? 'enabled' : 'disabled'}
                      className="h-9 gap-2 rounded-[8px] px-4 text-[13px] font-semibold"
                    >
                      {busy ? <Loader2 size={15} className="animate-spin" /> : <Power size={15} />}
                      确认权限并安装
                    </Button>
                  )}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Badge>{PLUGIN_SOURCE_LABELS[item.sourceType]}</Badge>
                <Badge>{formatPluginInstallState(installState)}</Badge>
                <Badge>{formatPluginEnableState(enableState)}</Badge>
                <Badge>v{item.version}</Badge>
              </div>

              {(marketplaceWebsite || marketplace?.docs) && (
                <div className="flex flex-wrap items-center gap-2 text-[12px] text-[var(--text-3)]">
                  {marketplaceWebsite && (
                    <a
                      href={marketplaceWebsite}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 rounded-[6px] border border-[var(--border)] px-2 py-1 text-[var(--text-2)] hover:text-[var(--text-1)]"
                    >
                      网站
                      <ExternalLink size={12} />
                    </a>
                  )}
                  {marketplace?.docs && (
                    <span className="rounded-[6px] border border-[var(--border)] px-2 py-1">
                      文档 {marketplace.docs}
                    </span>
                  )}
                </div>
              )}
            </header>

            {error && (
              <section className="rounded-[8px] bg-[color:color-mix(in_oklab,var(--lume-warning)_9%,var(--surface-1))] p-4 text-[13px] leading-6 text-[var(--lume-warning)]">
                {error}
              </section>
            )}

            <Tabs defaultValue="overview" className="gap-5">
              <TabsList
                variant="line"
                data-plugin-detail-tabs="horizontal"
                className="w-full justify-start border-b border-[var(--border)]"
              >
                <TabsTrigger value="overview" className="max-w-none flex-none px-0 text-[14px]">
                  概览
                </TabsTrigger>
                <TabsTrigger value="readme" className="max-w-none flex-none px-0 text-[14px]">
                  README
                </TabsTrigger>
                <TabsTrigger value="setup" className="max-w-none flex-none px-0 text-[14px]">
                  设置
                </TabsTrigger>
              </TabsList>

              <TabsContent value="overview" keepMounted>
                <section className="space-y-5">
                  {marketplaceMedia && <MarketplaceMedia media={marketplaceMedia} pluginName={pluginName} />}
                  <div className="grid gap-3 sm:grid-cols-3">
                    <SummaryStat label="安装状态" value={formatPluginInstallState(installState)} />
                    <SummaryStat label="启用状态" value={formatPluginEnableState(enableState)} />
                    <SummaryStat label="版本" value={`v${item.version}`} />
                  </div>
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
                </section>
              </TabsContent>

              <TabsContent value="readme" keepMounted>
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

              <TabsContent value="setup" keepMounted>
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
            </Tabs>

            {installedLike && (
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

function MarketplaceMedia({ media, pluginName }: { media: PluginMarketplaceAsset; pluginName: string }) {
  return (
    <div
      data-plugin-marketplace-media="true"
      className="overflow-hidden rounded-[8px] border border-[var(--border)] bg-[var(--surface-2)]"
    >
      {media.url ? (
        <img
          src={media.url}
          alt={`${pluginName} thumbnail`}
          className="h-auto max-h-[260px] w-full object-cover"
        />
      ) : (
        <div className="px-4 py-8 text-center text-[12px] text-[var(--text-3)]">
          {media.path}
        </div>
      )}
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

function SummaryStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[8px] bg-[var(--surface-2)] px-3 py-2">
      <div className="text-[12px] leading-5 text-[var(--text-3)]">{label}</div>
      <div className="mt-1 truncate text-[13px] font-semibold leading-5 text-[var(--text-1)]">{value}</div>
    </div>
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

function safeExternalUrl(value: string | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
  } catch {
    return null
  }
}

function dedupeDiagnostics(...groups: Array<PluginDiagnostic[] | undefined>): PluginDiagnostic[] {
  const seen = new Set<string>()
  const diagnostics: PluginDiagnostic[] = []

  for (const group of groups) {
    for (const diagnostic of group ?? []) {
      const key = `${diagnostic.severity}:${diagnostic.code}:${diagnostic.message}`
      if (seen.has(key)) continue
      seen.add(key)
      diagnostics.push(diagnostic)
    }
  }

  return diagnostics
}
