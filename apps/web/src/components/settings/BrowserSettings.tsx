import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { useAtomValue } from 'jotai'
import { ChevronRight, Globe, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import { agentWorkspacesAtom, currentWorkspaceIdAtom } from '@/atoms'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { BrowserImportModal } from '@/components/browser/BrowserImportModal'
import { BrowserDataManagers, type BrowserDataManagerKind, type BrowserDataManagersHandle } from './BrowserDataManagers'
import { getBrowserSettings, openFolderDialog, updateBrowserSettings } from '@/lib/desktop-api'
import { getMarketCatalog, getMarketDetail, installMarketItem, setPluginEnablement } from '@/lib/desktop-api'
import type { BrowserSettings as BrowserSettingsValue, BrowserSitePermission } from '@lume/shared'

export function BrowserSettings({ onOpenSkills: _onOpenSkills }: { onOpenSkills?: () => void }) {
  const [settings, setSettings] = useState<BrowserSettingsValue | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [overrideOrigin, setOverrideOrigin] = useState('')
  const [overridePermission, setOverridePermission] = useState<BrowserSitePermission>('browse')
  const [overrideDecision, setOverrideDecision] = useState<'ask' | 'allow' | 'deny'>('ask')
  const [pluginBusy, setPluginBusy] = useState<'browser' | 'chrome' | null>(null)
  const dataManagersRef = useRef<BrowserDataManagersHandle | null>(null)
  const [browserPlugins, setBrowserPlugins] = useState<Record<'browser' | 'chrome', BrowserPluginState | null>>({ browser: null, chrome: null })
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const currentWorkspaceId = useAtomValue(currentWorkspaceIdAtom)
  const workspaceSlug = workspaces.find((workspace) => workspace.id === currentWorkspaceId)?.slug ?? workspaces[0]?.slug ?? null
  const normalizedOverrideOrigin = normalizeOrigin(overrideOrigin)

  useEffect(() => { void getBrowserSettings().then(setSettings).catch(() => toast.error('浏览器设置不可用')) }, [])
  useEffect(() => {
    if (!workspaceSlug) { setBrowserPlugins({ browser: null, chrome: null }); return }
    void getMarketCatalog({ workspaceSlug, cacheMode: 'force-refresh' }).then((catalog) => setBrowserPlugins({
      browser: catalog.plugins.find((plugin) => plugin.pluginId === 'browser') ?? null,
      chrome: catalog.plugins.find((plugin) => plugin.pluginId === 'chrome') ?? null,
    })).catch(() => setBrowserPlugins({ browser: null, chrome: null }))
  }, [workspaceSlug])
  if (!settings) return <div className="lume-panel-padded text-sm text-[var(--text-3)]">正在读取浏览器设置…</div>
  const save = async (patch: Partial<BrowserSettingsValue>) => {
    try { setSettings(await updateBrowserSettings(patch)); toast.success('浏览器设置已保存') } catch { toast.error('浏览器设置保存失败') }
  }
  const pluginAction = async (pluginId: 'browser' | 'chrome') => {
    const plugin = browserPlugins[pluginId]
    if (!workspaceSlug || !plugin) return
    setPluginBusy(pluginId)
    try {
      if (plugin.installState !== 'installed') {
        const detail = await getMarketDetail({ workspaceSlug, kind: 'plugin', itemId: plugin.id })
        const inspect = detail.inspect
        if (detail.item.kind !== 'plugin' || !inspect || inspect.kind !== 'plugin') throw new Error(`${pluginId}_catalog_unavailable`)
        await installMarketItem({ workspaceSlug, kind: 'plugin', itemId: plugin.id, catalogItemKey: plugin.catalogItemKey, acceptedPermissionsHash: inspect.permissionsHash, enableScope: 'workspace' })
      } else await setPluginEnablement({ workspaceSlug, pluginId, scope: 'workspace', enabled: !plugin.enableState.includes('enabled') })
      const refreshed = await getMarketCatalog({ workspaceSlug, cacheMode: 'force-refresh' })
      setBrowserPlugins({
        browser: refreshed.plugins.find((item) => item.pluginId === 'browser') ?? null,
        chrome: refreshed.plugins.find((item) => item.pluginId === 'chrome') ?? null,
      })
    } catch (error) { toast.error(error instanceof Error ? error.message : `${pluginId} 插件操作失败`) } finally { setPluginBusy(null) }
  }
  return <div className="space-y-3">
    <section className="lume-panel-padded">
      <div className="mb-4 flex items-start gap-3"><Globe className="mt-1 text-[var(--brand)]" size={19} /><div><h2 className="text-[16px] font-semibold text-[var(--text-1)]">Lume 浏览器</h2><p className="mt-1 text-[12px] leading-5 text-[var(--text-3)]">Browser 控制内置浏览器；Chrome 连接用户已有的 Chrome 标签和登录态。</p></div></div>
      <div className="divide-y divide-[var(--border)] rounded-lg border border-[var(--border)]">
        <BrowserPluginRow title="Browser 插件" description="控制任务隔离的 Lume Browser 页面。" plugin={browserPlugins.browser} busy={pluginBusy === 'browser'} disabled={pluginBusy !== null} unavailableLabel={workspaceSlug ? '当前目录没有可用的 browser catalog 项' : '没有当前工作区，暂不可用'} onAction={() => void pluginAction('browser')} />
        <BrowserPluginRow title="Chrome 插件" description="连接 Chrome 扩展和 Native Host；不会回退到内置浏览器。" plugin={browserPlugins.chrome} busy={pluginBusy === 'chrome'} disabled={pluginBusy !== null} unavailableLabel={workspaceSlug ? '当前目录没有可用的 chrome catalog 项' : '没有当前工作区，暂不可用'} onAction={() => void pluginAction('chrome')} />
      </div>
    </section>
    <section className="lume-panel-padded"><SectionTitle title="常规" description="控制浏览器、链接打开位置和网页审阅体验。" />
      <SettingRow title="启用 Lume 浏览器" description="关闭后不再创建或恢复内置浏览器页面。"><Switch checked={settings.browserEnabled !== false} onCheckedChange={(checked) => void save({ browserEnabled: checked })} /></SettingRow>
      <SettingRow title="允许 Browser Use" description="允许启用的 Browser 插件在任务隔离会话中控制网页。"><Switch disabled={settings.browserEnabled === false} checked={settings.browserUseEnabled !== false} onCheckedChange={(checked) => void save({ browserUseEnabled: checked })} /></SettingRow>
      <SettingRow title="网页链接打开目标" description="明确选择链接的打开动作。"><Select value={settings.linkOpenTarget} onValueChange={(value) => void save({ linkOpenTarget: value as 'lume' | 'system' })}><SelectTrigger className="w-28"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="lume">Lume</SelectItem><SelectItem value="system">系统</SelectItem></SelectContent></Select></SettingRow>
      <SettingRow title="本地 URL 默认目标" description="本地开发地址的默认打开位置。"><Select value={settings.localUrlTarget} onValueChange={(value) => void save({ localUrlTarget: value as 'lume' | 'system' })}><SelectTrigger className="w-28"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="lume">Lume</SelectItem><SelectItem value="system">系统</SelectItem></SelectContent></Select></SettingRow>
      <SettingRow title="显示 Agent 浏览器光标" description="显示虚拟光标和点击反馈，不移动系统鼠标。"><Switch checked={settings.agentCursorVisible} onCheckedChange={(checked) => void save({ agentCursorVisible: checked })} /></SettingRow>
      <SettingRow title="审阅截图" description="决定网页批注何时自动附加页面截图。"><Select value={settings.annotationScreenshots === 'ask' ? 'necessary' : settings.annotationScreenshots} onValueChange={(value) => void save({ annotationScreenshots: value as BrowserSettingsValue['annotationScreenshots'] })}><SelectTrigger className="w-40"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="always">始终附加</SelectItem><SelectItem value="necessary">仅拖拽区域时</SelectItem><SelectItem value="off">从不附加</SelectItem></SelectContent></Select></SettingRow>
    </section>
    <section className="lume-panel-padded"><SectionTitle title="Browser Use" description="设置 Agent 打开网站和读取浏览历史时的审批方式。" />
      <SettingRow title="网站访问审批" description={settings.browserApprovalMode === 'neverAsk' ? 'Agent 可直接打开网站；本地与私有地址仍单独确认。' : 'Agent 每次打开新网站前都需要确认。'}><Select value={settings.browserApprovalMode} onValueChange={(value) => void save({ browserApprovalMode: value as BrowserSettingsValue['browserApprovalMode'] })}><SelectTrigger className="w-44"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="alwaysAsk">打开网站前询问</SelectItem><SelectItem value="neverAsk">始终允许</SelectItem></SelectContent></Select></SettingRow>
      {settings.browserApprovalMode === 'neverAsk' && <div className="rounded-lg border border-amber-500/30 bg-amber-500/8 px-3 py-2 text-[12px] leading-5 text-amber-700 dark:text-amber-300">始终允许会减少每次导航的确认，但网站提交、下载、上传、凭证和完整 CDP 等敏感动作仍保持独立审批。</div>}
      <SettingRow title="Lume 浏览历史" description="控制 Browser 插件读取内置浏览器历史的权限。"><HistoryApprovalSelect value={settings.iabHistoryApprovalMode} onChange={(value) => void save({ iabHistoryApprovalMode: value })} /></SettingRow>
      <SettingRow title="Chrome 浏览历史" description="控制 Chrome 插件读取用户 Chrome 历史的权限。"><HistoryApprovalSelect disabled={!settings.extensionBackendEnabled} value={settings.chromeHistoryApprovalMode} onChange={(value) => void save({ chromeHistoryApprovalMode: value })} /></SettingRow>
    </section>
    <section className="lume-panel-padded"><SectionTitle title="浏览器数据" description="管理 Lume 浏览器保存的数据、扩展和导入来源。" />
      <ManagedSettingRow title="密码管理器" description="添加、查看来源或删除保存的密码。" manager="passwords" managerRef={dataManagersRef} />
      <ManagedSettingRow title="联系信息" description="管理用于安全自动填充的姓名、邮箱、电话和地址。" manager="contacts" managerRef={dataManagersRef} />
      <ManagedSettingRow title="下载内容" description="查看并清除不含完整本机路径的下载记录。" manager="downloads" managerRef={dataManagersRef} />
      <ManagedSettingRow title="扩展程序" description="安装、启停或移除用户确认的本地 unpacked 扩展。" manager="extensions" managerRef={dataManagersRef} />
      <ManagedSettingRow title="历史记录" description="搜索、删除或清除本机浏览历史。" manager="history" managerRef={dataManagersRef} />
      <ManagedSettingRow title="清除浏览数据" description="分别清除 Cookie、站点数据、缓存、历史、下载和权限。" manager="clear" managerRef={dataManagersRef} />
      <SettingRow title="导入浏览器 Profile" description="从已关闭的 Chrome Profile 导入 Cookie 和保存的密码。"><Button variant="ghost" size="sm" onClick={() => setImportOpen(true)}>管理<ChevronRight size={14} /></Button></SettingRow>
      <BrowserDataManagers ref={dataManagersRef} showLauncher={false} onImport={() => setImportOpen(true)} />
    </section>
    <section className="lume-panel-padded"><SectionTitle title="下载" description="用户下载目录、保存前确认和无敏感路径的下载历史。" />
      <SettingRow title="下载前询问" description="用户下载使用受控目录。"><Switch checked={settings.downloadAskBeforeSave} onCheckedChange={(checked) => void save({ downloadAskBeforeSave: checked })} /></SettingRow>
      <SettingRow title="下载历史" description="仅保存非敏感文件引用和状态。"><Switch checked={settings.downloadHistoryEnabled} onCheckedChange={(checked) => void save({ downloadHistoryEnabled: checked })} /></SettingRow>
      <SettingRow title="下载目录" description={settings.downloadDirectory || '系统默认下载文件夹'}><Button variant="outline" size="sm" onClick={() => void openFolderDialog().then((result) => { if (result.path) return save({ downloadDirectory: result.path }) })}>更改</Button></SettingRow>
    </section>
    <section className="lume-panel-padded"><div className="mb-3 flex items-start gap-3"><ShieldCheck className="mt-1 text-[var(--brand)]" size={18} /><SectionTitle title="权限" description="网站权限和完整 origin 覆盖；Agent task partition 默认拒绝敏感权限。" /></div>
      <SettingRow title="站点权限默认策略" description="摄像头、麦克风、通知等权限不会自动授予。"><Select value={settings.sitePermissionDefault} onValueChange={(value) => void save({ sitePermissionDefault: value as 'ask' | 'deny' })}><SelectTrigger className="w-28"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="ask">询问</SelectItem><SelectItem value="deny">拒绝</SelectItem></SelectContent></Select></SettingRow>
      <div className="border-t border-[var(--border)] py-3"><div className="text-[13px] font-medium text-[var(--text-2)]">按 origin 的权限</div><div className="mt-2 grid gap-2 sm:grid-cols-[minmax(0,1fr)_120px_88px_auto]"><Input value={overrideOrigin} onChange={(event) => setOverrideOrigin(event.target.value)} placeholder="https://example.com" /><Select value={overridePermission} onValueChange={(value) => setOverridePermission(value as BrowserSitePermission)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{Object.entries(PERMISSION_LABELS).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select><Select value={overrideDecision} onValueChange={(value) => setOverrideDecision(value as typeof overrideDecision)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="ask">询问</SelectItem><SelectItem value="allow">允许</SelectItem><SelectItem value="deny">拒绝</SelectItem></SelectContent></Select><Button variant="outline" size="sm" disabled={!normalizedOverrideOrigin} onClick={() => { if (!normalizedOverrideOrigin) return; const current = settings.sitePermissionOverrides?.[normalizedOverrideOrigin] ?? {}; void save({ sitePermissionOverrides: { ...(settings.sitePermissionOverrides ?? {}), [normalizedOverrideOrigin]: { ...current, [overridePermission]: overrideDecision } } }); setOverrideOrigin('') }}>保存</Button></div></div>
      {Object.entries(settings.sitePermissionOverrides ?? {}).flatMap(([origin, permissions]) => Object.entries(permissions).map(([permission, decision]) => <div key={`${origin}:${permission}`} className="flex items-center justify-between gap-3 border-t border-[var(--border)] py-3"><div className="min-w-0"><div className="truncate text-[13px] text-[var(--text-2)]">{origin}</div><div className="text-[12px] text-[var(--text-3)]">{PERMISSION_LABELS[permission as BrowserSitePermission]} · {decision === 'allow' ? '允许' : decision === 'deny' ? '拒绝' : '询问'}</div></div><Button variant="ghost" size="sm" onClick={() => { const next = { ...(settings.sitePermissionOverrides ?? {}) }; const originPermissions = { ...next[origin] }; delete originPermissions[permission as BrowserSitePermission]; if (Object.keys(originPermissions).length) next[origin] = originPermissions; else delete next[origin]; void save({ sitePermissionOverrides: next }) }}>移除</Button></div>))}
    </section>
    <section className="lume-panel-padded"><SectionTitle title="开发者模式" description="高风险能力只对新建的隔离空白 Profile 生效。" />
      <SettingRow title="外部 Chrome backend" description="需要独立启用 lume-chrome 和在线 Native Host，不会回退。"><Switch checked={settings.extensionBackendEnabled} onCheckedChange={(checked) => void save({ extensionBackendEnabled: checked })} /></SettingRow>
      <SettingRow title="完整 CDP 访问权限" description="仅隔离临时会话；还需站点 CDP 权限，并在每次动作时确认。"><Switch checked={settings.advancedCdpEnabled} onCheckedChange={(checked) => void save({ advancedCdpEnabled: checked })} /></SettingRow>
    </section>
    <BrowserImportModal open={importOpen} onOpenChange={setImportOpen} />
  </div>
}

function SettingRow({ title, description, children }: { title: string; description: string; children: ReactNode }) { return <div className="flex min-h-[54px] items-center justify-between gap-5 border-t border-[var(--border)] py-3"><div className="min-w-0"><div className="text-[13px] font-medium text-[var(--text-2)]">{title}</div><div className="mt-0.5 text-[12px] leading-4 text-[var(--text-3)]">{description}</div></div>{children}</div> }
function BrowserPluginRow({ title, description, plugin, busy, disabled, unavailableLabel, onAction }: { title: string; description: string; plugin: BrowserPluginState | null; busy: boolean; disabled: boolean; unavailableLabel: string; onAction: () => void }) { return <div className="flex items-center justify-between gap-4 p-3"><div className="min-w-0"><div className="text-[13px] font-medium text-[var(--text-2)]">{title}</div><div className="mt-0.5 text-[12px] text-[var(--text-3)]">{description}</div><div className="mt-1 text-[11px] text-[var(--text-3)]">{plugin ? `${plugin.installState === 'installed' ? '已安装' : '可安装'} · ${plugin.enableState.includes('enabled') ? '已启用' : '未启用'}` : unavailableLabel}</div></div><Button type="button" variant="outline" size="sm" disabled={!plugin || disabled} onClick={onAction}>{busy ? '处理中…' : plugin?.installState === 'installed' ? (plugin.enableState.includes('enabled') ? '停用' : '启用') : '安装'}</Button></div> }
function ManagedSettingRow({ title, description, manager, managerRef }: { title: string; description: string; manager: BrowserDataManagerKind; managerRef: RefObject<BrowserDataManagersHandle | null> }) { return <SettingRow title={title} description={description}><Button variant="ghost" size="sm" onClick={() => managerRef.current?.open(manager)}>管理<ChevronRight size={14} /></Button></SettingRow> }
function HistoryApprovalSelect({ value, disabled, onChange }: { value: BrowserSettingsValue['iabHistoryApprovalMode']; disabled?: boolean; onChange: (value: BrowserSettingsValue['iabHistoryApprovalMode']) => void }) { return <Select disabled={disabled} value={value} onValueChange={(next) => onChange(next as BrowserSettingsValue['iabHistoryApprovalMode'])}><SelectTrigger className="w-40"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="alwaysAsk">每次询问</SelectItem><SelectItem value="neverAsk">始终允许</SelectItem><SelectItem value="disabled">不允许</SelectItem></SelectContent></Select> }
function SectionTitle({ title, description }: { title: string; description: string }) { return <div className="mb-3"><h2 className="text-[15px] font-semibold text-[var(--text-1)]">{title}</h2><p className="mt-1 text-[12px] text-[var(--text-3)]">{description}</p></div> }
function normalizeOrigin(value: string): string { try { const url = new URL(value.trim()); return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash ? url.origin : '' } catch { return '' } }
const PERMISSION_LABELS: Record<BrowserSitePermission, string> = { browse: '浏览', download: '下载', upload: '上传', cdp: '完整 CDP', camera: '摄像头', microphone: '麦克风' }
type BrowserPluginState = { id: string; pluginId: string; installState: string; enableState: string; catalogItemKey?: string }
