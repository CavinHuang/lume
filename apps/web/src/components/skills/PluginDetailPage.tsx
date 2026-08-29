import { XMarkdown } from '@ant-design/x-markdown'
import { DIFF_AWARE_MARKDOWN_COMPONENTS } from '@/components/markdown/DiffAwareMarkdownPre'
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Loader2,
  MoreHorizontal,
  Power,
  RotateCcw,
  Server,
  Sparkles,
  Trash2,
  Webhook,
  Wrench,
} from 'lucide-react'
import type { ReactNode } from 'react'
import type { GetMarketDetailResult, PluginMarketplaceAsset } from '@lume/shared'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { PLUGIN_SOURCE_LABELS } from './plugin-market-ui-state'
import { PluginLogo } from './PluginLogo'
import {
  buildPermissionRows,
  buildPluginUpdateAction,
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
  onPreparePackage?: (setupStepId: string) => void
  onInstallPackage?: (setupStepId: string) => void
  onRollback?: () => void
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
  onPreparePackage,
  onInstallPackage,
  onRollback,
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
  const permissionChanged = Boolean(updateAvailable && item && (!inspected || item.installedPermissionsHash !== inspected.permissionsHash))
  const updateAction = item ? buildPluginUpdateAction({
    updateAvailable,
    permissionChanged,
    version: item.version,
  }) : null
  const currentVersion = item?.installedVersion ?? item?.version ?? ''
  const rollbackVersion = item?.rollbackVersion

  const renderPrimaryAction = () => {
    if (updateAvailable) {
      return (
        <Button
          type="button"
          disabled={!canUpdate || busy}
          onClick={onInstall}
          data-plugin-detail-install-action={canUpdate && !busy ? 'enabled' : 'disabled'}
          className="h-9 gap-1.5 rounded-lg px-4 text-[13px] font-semibold"
        >
          {busy ? <Loader2 size={15} className="animate-spin" /> : null}
          {updateAction?.label ?? '确认权限并更新'}
        </Button>
      )
    }
    if (installedLike && enabled) {
      return (
        <Button
          type="button"
          disabled={busy}
          onClick={onTryInChat}
          data-plugin-detail-header-action="try"
          className="h-9 gap-1.5 rounded-lg px-4 text-[13px] font-semibold"
        >
          <Sparkles size={15} />
          立即试用
        </Button>
      )
    }
    if (installedLike) {
      return (
        <Button
          type="button"
          disabled={busy}
          onClick={onToggleEnable}
          data-plugin-detail-header-action="enable"
          className="h-9 gap-1.5 rounded-lg px-4 text-[13px] font-semibold"
        >
          <Power size={15} />
          启用
        </Button>
      )
    }
    return (
      <Button
        type="button"
        disabled={!canInstall || busy}
        onClick={onInstall}
        data-plugin-detail-install-action={canInstall && !busy ? 'enabled' : 'disabled'}
        className="h-9 gap-1.5 rounded-lg px-4 text-[13px] font-semibold"
      >
        {busy ? <Loader2 size={15} className="animate-spin" /> : null}
        确认权限并安装
      </Button>
    )
  }

  return (
    <div
      data-plugin-detail-shell="full-width"
      className="h-full min-h-0 min-w-0 flex-1 overflow-y-auto bg-[var(--background)]"
    >
      <main className="mx-auto w-full max-w-[1060px] px-6 py-6">
        <nav className="flex items-center gap-1.5 text-[13px] text-[var(--text-3)]">
          <button
            type="button"
            onClick={onBack}
            className="rounded px-0.5 transition-colors hover:text-[var(--text-1)]"
          >
            插件市场
          </button>
          <ChevronRight size={14} />
          <span className="min-w-0 truncate text-[var(--text-1)]">{pluginName}</span>
        </nav>

        {loading ? (
          <div role="status" className="flex min-h-[320px] items-center justify-center gap-2 text-[13px] text-[var(--text-3)]">
            <Loader2 size={16} className="animate-spin" />
            正在读取插件详情...
          </div>
        ) : error && !item ? (
          <section role="alert" className="mt-8 rounded-lg border border-[color:color-mix(in_oklab,var(--lume-danger)_28%,var(--border))] bg-[color:color-mix(in_oklab,var(--lume-danger)_7%,var(--surface-1))] p-5 text-[13px] leading-6 text-[var(--lume-danger)]">
            {error}
          </section>
        ) : item ? (
          <div>
            <header className="mt-7">
              <div className="flex size-16 items-center justify-center overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface-2)]">
                <PluginLogo src={marketplace?.icon?.url} alt={`${pluginName} 图标`} className="size-full" />
              </div>
              <div className="mt-4 flex items-start justify-between gap-4">
                <h1 className="min-w-0 text-[28px] font-bold leading-9 text-[var(--text-1)]">{pluginName}</h1>
                <div className="flex shrink-0 items-center gap-2">
                  {installedLike && (
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button
                            variant="ghost"
                            type="button"
                            size="icon"
                            disabled={busy}
                            className="size-9 rounded-lg border border-[color:color-mix(in_oklab,var(--border-strong)_48%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-2)_58%,var(--surface-1))] text-[var(--text-2)] hover:text-[var(--text-1)]"
                            title="更多操作"
                        />
                      }
                    >
                      <MoreHorizontal size={16} />
                    </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="min-w-[128px]">
                        <DropdownMenuItem onSelect={onToggleEnable}>
                          <Power size={14} />
                          {enabled ? '禁用' : '启用'}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem destructive onSelect={onUninstall}>
                          <Trash2 size={14} />
                          卸载
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                  {renderPrimaryAction()}
                </div>
              </div>
              <p className="mt-2 max-w-[760px] text-[15px] leading-6 text-[var(--text-2)]">
                {item.description ?? '暂无描述。'}
              </p>
            </header>

            {error && (
              <section className="mt-5 rounded-lg bg-[color:color-mix(in_oklab,var(--lume-warning)_9%,var(--surface-1))] p-4 text-[13px] leading-6 text-[var(--lume-warning)]">
                {error}
              </section>
            )}

            {marketplaceMedia && (
              <div className="mt-6">
                <MarketplaceMedia media={marketplaceMedia} pluginName={pluginName} />
              </div>
            )}

            {item.capabilities.mcpServerNames.length > 0 && (
              <DetailSection title="MCP 服务器" count={item.capabilities.mcpServerNames.length}>
                <div className="space-y-1">
                  {item.capabilities.mcpServerNames.map((serverName) => (
                    <CapabilityRow key={serverName} icon={<Server size={16} />} name={serverName} />
                  ))}
                </div>
              </DetailSection>
            )}

            {item.capabilities.skillCount > 0 && (
              <DetailSection title="技能" count={item.capabilities.skillCount}>
                <CapabilityRow icon={<Sparkles size={16} />} name={`共 ${item.capabilities.skillCount} 个技能`} />
              </DetailSection>
            )}

            {item.capabilities.commandToolNames.length > 0 && (
              <DetailSection title="命令与工具" count={item.capabilities.commandToolNames.length}>
                <div className="space-y-1">
                  {item.capabilities.commandToolNames.map((toolName) => (
                    <CapabilityRow key={toolName} icon={<Wrench size={16} />} name={toolName} />
                  ))}
                </div>
              </DetailSection>
            )}

            {item.capabilities.hookEvents.length > 0 && (
              <DetailSection title="钩子事件" count={item.capabilities.hookEvents.length}>
                <div className="flex flex-wrap gap-2">
                  {item.capabilities.hookEvents.map((hookEvent) => (
                    <span
                      key={hookEvent}
                      className="inline-flex items-center gap-1.5 rounded-md border border-[color:color-mix(in_oklab,var(--border-strong)_40%,transparent)] px-2 py-1 text-[12px] text-[var(--text-2)]"
                    >
                      <Webhook size={12} className="text-[var(--text-3)]" />
                      {hookEvent}
                    </span>
                  ))}
                </div>
              </DetailSection>
            )}

            <DetailSection title="权限审核">
              <div className="flex flex-wrap gap-2">
                {item.permissions.riskLabels.length > 0 ? (
                  item.permissions.riskLabels.map((risk) => (
                    <span
                      key={risk}
                      className="rounded-md bg-[color:color-mix(in_oklab,var(--lume-warning)_12%,var(--surface-1))] px-2 py-1 text-[12px] font-medium text-[var(--lume-warning)]"
                    >
                      {formatRiskLabel(risk)}
                    </span>
                  ))
                ) : (
                  <span className="rounded-md bg-[color:color-mix(in_oklab,var(--lume-success)_10%,var(--surface-1))] px-2 py-1 text-[12px] font-medium text-[var(--lume-success)]">
                    低风险
                  </span>
                )}
              </div>
              <div className="mt-3 divide-y divide-[color:color-mix(in_oklab,var(--border-strong)_18%,transparent)]">
                {permissionRows.map((row) => (
                  <div key={row.label} className="grid grid-cols-[130px_minmax(0,1fr)] gap-3 py-2.5 text-[13px] leading-5">
                    <span className="text-[var(--text-3)]">{row.label}</span>
                    <span className="break-all text-[var(--text-2)]">{row.value}</span>
                  </div>
                ))}
              </div>
            </DetailSection>

            <DetailSection title="信息">
              <div className="divide-y divide-[color:color-mix(in_oklab,var(--border-strong)_18%,transparent)]">
                <InfoRow label="类别" value={PLUGIN_SOURCE_LABELS[item.sourceType]} />
                {updateAvailable ? (
                  <>
                    <InfoRow label="当前版本" value={`v${currentVersion}`} />
                    <InfoRow label="可更新版本" value={`v${item.version}`} />
                  </>
                ) : (
                  <InfoRow label="版本" value={`v${item.version}`} />
                )}
                <InfoRow label="安装状态" value={formatPluginInstallState(installState)} />
                <InfoRow label="启用状态" value={formatPluginEnableState(enableState)} />
                {marketplaceWebsite && (
                  <InfoRow
                    label="网站"
                    value={(
                      <a
                        href={marketplaceWebsite}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-[var(--text-2)] hover:text-[var(--text-1)]"
                      >
                        {marketplaceWebsite}
                        <ExternalLink size={12} />
                      </a>
                    )}
                  />
                )}
                {marketplace?.docs && <InfoRow label="文档" value={marketplace.docs} mono />}
              </div>
            </DetailSection>

            <DetailSection title="README">
              {readme ? (
                <div className="space-y-2">
                  <div className="text-[12px] text-[var(--text-3)]">{formatReadmeMeta(readme)}</div>
                  <XMarkdown components={DIFF_AWARE_MARKDOWN_COMPONENTS} className="x-markdown text-[14.5px] leading-8 text-[var(--text-1)]">
                    {readme.markdown}
                  </XMarkdown>
                </div>
              ) : (
                <div className="rounded-lg border border-dashed border-[var(--border)] p-6 text-center text-[13px] text-[var(--text-3)]">
                  未找到 README.md
                </div>
              )}
            </DetailSection>

            {setupItems.length > 0 && (
              <DetailSection title="配置与安装">
                <div className="space-y-3">
                  {setupItems.map((setup) => (
                    <div
                      key={setup.title}
                      className="flex gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-4"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="text-[13.5px] font-semibold text-[var(--text-1)]">{setup.title}</div>
                        <div className="mt-1 text-[12.5px] leading-5 text-[var(--text-3)]">{setup.description}</div>
                      </div>
                      {setup.installer && onInstallPackage && setup.id ? (
                        <Button type="button" disabled={busy} className="h-8 shrink-0 text-[12px]" onClick={() => onInstallPackage(setup.id!)}>
                          安装 Native Host
                        </Button>
                      ) : (setup.artifact || setup.artifacts?.length || setup.download) && onPreparePackage && setup.id ? (
                        <Button type="button" variant="outline" disabled={busy} className="h-8 shrink-0 text-[12px]" onClick={() => onPreparePackage(setup.id!)}>
                          {setup.targetApp?.kind === 'chrome' ? '保存 Chrome 扩展包' : setup.targetApp?.kind === 'obsidian' ? '导出 Obsidian 插件包' : '保存配套包'}
                        </Button>
                      ) : null}
                    </div>
                  ))}
                </div>
              </DetailSection>
            )}

            <details className="group mt-9 border-t border-[color:color-mix(in_oklab,var(--border-strong)_22%,transparent)] pt-4">
              <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 text-[13px] text-[var(--text-3)] transition-colors hover:text-[var(--text-1)] [&::-webkit-details-marker]:hidden">
                <ChevronDown size={14} className="transition-transform group-open:rotate-180" />
                高级信息
              </summary>
              <div className="mt-3 space-y-3">
                {inspected && (
                  <div className="rounded-lg border border-[color:color-mix(in_oklab,var(--border-strong)_36%,transparent)] px-3.5 py-3 text-[12.5px] leading-5">
                    <div className="text-[var(--text-3)]">权限 hash</div>
                    <div className="mt-0.5 break-all font-mono text-[var(--text-2)]">{inspected.permissionsHash}</div>
                  </div>
                )}
                {rollbackVersion && onRollback && (
                  <Button
                    variant="ghost"
                    type="button"
                    disabled={busy}
                    onClick={onRollback}
                    className="h-8 gap-2 rounded-lg border border-[var(--border)] px-3 text-[12.5px] font-semibold text-[var(--text-2)]"
                  >
                    <RotateCcw size={14} />
                    回滚到 v{rollbackVersion}
                  </Button>
                )}
                {diagnostics.length > 0 ? (
                  <ul className="space-y-2 text-[13px] leading-6 text-[var(--lume-warning)]">
                    {diagnostics.map((diagnostic, index) => (
                      <li
                        key={`${diagnostic.code}-${index}`}
                        className="rounded-lg bg-[color:color-mix(in_oklab,var(--lume-warning)_9%,var(--surface-1))] p-3"
                      >
                        {diagnostic.message}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="text-[12.5px] text-[var(--text-3)]">当前插件未返回需要处理的问题。</div>
                )}
              </div>
            </details>
          </div>
        ) : (
          <div className="mt-8 rounded-lg border border-dashed border-[var(--border)] p-8 text-center">
            <div className="text-[14px] font-semibold text-[var(--text-1)]">暂无插件详情</div>
            <div className="mt-2 text-[13px] leading-6 text-[var(--text-3)]">返回插件市场后重新选择一个插件。</div>
          </div>
        )}
      </main>
    </div>
  )
}

function DetailSection({
  title,
  count,
  children,
}: {
  title: string
  count?: number
  children: ReactNode
}) {
  return (
    <section className="mt-9">
      <div className="flex items-baseline gap-2 border-b border-[color:color-mix(in_oklab,var(--border-strong)_30%,transparent)] pb-2.5">
        <h2 className="text-[16px] font-semibold text-[var(--text-1)]">{title}</h2>
        {typeof count === 'number' && <span className="text-[13px] text-[var(--text-3)]">{count}</span>}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  )
}

function CapabilityRow({ icon, name }: { icon: ReactNode; name: string }) {
  return (
    <div className="flex items-center gap-3 rounded-lg px-1 py-2">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[var(--surface-2)] text-[var(--text-2)]">
        {icon}
      </span>
      <span className="min-w-0 truncate text-[14px] text-[var(--text-1)]">{name}</span>
    </div>
  )
}

function InfoRow({ label, value, mono = false }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[130px_minmax(0,1fr)] gap-3 py-2.5 text-[13.5px] leading-5">
      <span className="text-[var(--text-3)]">{label}</span>
      <span className={cn('min-w-0 break-all text-[var(--text-1)]', mono && 'font-mono text-[12.5px]')}>{value}</span>
    </div>
  )
}

function MarketplaceMedia({ media, pluginName }: { media: PluginMarketplaceAsset; pluginName: string }) {
  return (
    <div
      data-plugin-marketplace-media="true"
      className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-2)]"
    >
      {media.url ? (
        <img
          src={media.url}
          alt={`${pluginName} thumbnail`}
          className="h-auto max-h-[380px] w-full object-cover"
        />
      ) : (
        <div className="px-4 py-8 text-center text-[12px] text-[var(--text-3)]">
          {media.path}
        </div>
      )}
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
