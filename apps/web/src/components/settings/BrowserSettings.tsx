import { useEffect, useState, type ReactNode } from 'react'
import { useAtomValue } from 'jotai'
import { Globe, KeyRound, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import { agentWorkspacesAtom, currentWorkspaceIdAtom } from '@/atoms'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { BrowserImportModal } from '@/components/browser/BrowserImportModal'
import { BrowserDataManagers } from './BrowserDataManagers'
import { getBrowserSettings, openFolderDialog, updateBrowserSettings } from '@/lib/desktop-api'
import { getMarketCatalog, getMarketDetail, installMarketItem, setPluginEnablement } from '@/lib/desktop-api'
import type { BrowserSettings as BrowserSettingsValue, BrowserSitePermission } from '@lume/shared'

export function BrowserSettings({ onOpenSkills: _onOpenSkills }: { onOpenSkills?: () => void }) {
  const [settings, setSettings] = useState<BrowserSettingsValue | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [overrideOrigin, setOverrideOrigin] = useState('')
  const [overridePermission, setOverridePermission] = useState<BrowserSitePermission>('browse')
  const [overrideDecision, setOverrideDecision] = useState<'ask' | 'allow' | 'deny'>('ask')
  const [pluginBusy, setPluginBusy] = useState(false)
  const [browserPlugin, setBrowserPlugin] = useState<{ id: string; pluginId: string; installState: string; enableState: string; catalogItemKey?: string } | null>(null)
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const currentWorkspaceId = useAtomValue(currentWorkspaceIdAtom)
  const workspaceSlug = workspaces.find((workspace) => workspace.id === currentWorkspaceId)?.slug ?? workspaces[0]?.slug ?? null
  const normalizedOverrideOrigin = normalizeOrigin(overrideOrigin)

  useEffect(() => { void getBrowserSettings().then(setSettings).catch(() => toast.error('浏览器设置不可用')) }, [])
  useEffect(() => {
    if (!workspaceSlug) { setBrowserPlugin(null); return }
    void getMarketCatalog({ workspaceSlug, cacheMode: 'force-refresh' }).then((catalog) => setBrowserPlugin(catalog.plugins.find((plugin) => plugin.pluginId === 'browser') ?? null)).catch(() => setBrowserPlugin(null))
  }, [workspaceSlug])
  if (!settings) return <div className="lume-panel-padded text-sm text-[var(--text-3)]">正在读取浏览器设置…</div>
  const save = async (patch: Partial<BrowserSettingsValue>) => {
    try { setSettings(await updateBrowserSettings(patch)); toast.success('浏览器设置已保存') } catch { toast.error('浏览器设置保存失败') }
  }
  const pluginAction = async () => {
    if (!workspaceSlug || !browserPlugin) return
    setPluginBusy(true)
    try {
      if (browserPlugin.installState !== 'installed') {
        const detail = await getMarketDetail({ workspaceSlug, kind: 'plugin', itemId: browserPlugin.id })
        const inspect = detail.inspect
        if (detail.item.kind !== 'plugin' || !inspect || inspect.kind !== 'plugin') throw new Error('browser_catalog_unavailable')
        await installMarketItem({ workspaceSlug, kind: 'plugin', itemId: browserPlugin.id, catalogItemKey: browserPlugin.catalogItemKey, acceptedPermissionsHash: inspect.permissionsHash, enableScope: 'workspace' })
      } else await setPluginEnablement({ workspaceSlug, pluginId: 'browser', scope: 'workspace', enabled: !browserPlugin.enableState.includes('enabled') })
      const refreshed = await getMarketCatalog({ workspaceSlug, cacheMode: 'force-refresh' })
      setBrowserPlugin(refreshed.plugins.find((plugin) => plugin.pluginId === 'browser') ?? null)
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Browser 插件操作失败') } finally { setPluginBusy(false) }
  }
  return <div className="space-y-3">
    <section className="lume-panel-padded">
      <div className="mb-4 flex items-start gap-3"><Globe className="mt-1 text-[var(--brand)]" size={19} /><div><h2 className="text-[16px] font-semibold text-[var(--text-1)]">Lume 浏览器</h2><p className="mt-1 text-[12px] leading-5 text-[var(--text-3)]">普通用户浏览与 Agent 能力分离；Agent 入口由独立 browser 插件控制。</p></div></div>
      <div className="rounded-lg border border-[var(--border)] p-3"><div className="flex items-center justify-between gap-3"><div><div className="text-[13px] font-medium text-[var(--text-2)]">Lume Browser 插件</div><div className="mt-1 text-[12px] text-[var(--text-3)]">{browserPlugin ? `${browserPlugin.installState === 'installed' ? '已安装' : '可安装'} · ${browserPlugin.enableState.includes('enabled') ? '已启用' : '未启用'}` : workspaceSlug ? '当前目录没有可用的 browser catalog 项' : '没有当前工作区，暂不可用'}</div></div><Button type="button" variant="outline" size="sm" disabled={!browserPlugin || pluginBusy} onClick={() => void pluginAction()}>{pluginBusy ? '处理中…' : browserPlugin?.installState === 'installed' ? (browserPlugin.enableState.includes('enabled') ? '管理 / 停用' : '启用') : '安装 browser 插件'}</Button></div></div>
    </section>
    <section className="lume-panel-padded"><SectionTitle title="常规" description="链接打开位置、协同光标和截图策略。" />
      <SettingRow title="启用 Lume 浏览器" description="关闭后不再创建或恢复内置浏览器页面。"><Switch checked={settings.browserEnabled !== false} onCheckedChange={(checked) => void save({ browserEnabled: checked })} /></SettingRow>
      <SettingRow title="允许 Browser Use" description="允许启用的 Browser 插件在任务隔离会话中控制网页。"><Switch disabled={settings.browserEnabled === false} checked={settings.browserUseEnabled !== false} onCheckedChange={(checked) => void save({ browserUseEnabled: checked })} /></SettingRow>
      <SettingRow title="网页链接打开目标" description="明确选择链接的打开动作。"><Select value={settings.linkOpenTarget} onValueChange={(value) => void save({ linkOpenTarget: value as 'lume' | 'system' })}><SelectTrigger className="w-28"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="lume">Lume</SelectItem><SelectItem value="system">系统</SelectItem></SelectContent></Select></SettingRow>
      <SettingRow title="本地 URL 默认目标" description="本地开发地址的默认打开位置。"><Select value={settings.localUrlTarget} onValueChange={(value) => void save({ localUrlTarget: value as 'lume' | 'system' })}><SelectTrigger className="w-28"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="lume">Lume</SelectItem><SelectItem value="system">系统</SelectItem></SelectContent></Select></SettingRow>
      <SettingRow title="显示 Agent 浏览器光标" description="显示虚拟光标和点击反馈，不移动系统鼠标。"><Switch checked={settings.agentCursorVisible} onCheckedChange={(checked) => void save({ agentCursorVisible: checked })} /></SettingRow>
      <SettingRow title="截图标注" description="控制 Agent 证据截图是否带标注。"><Select value={settings.annotationScreenshots} onValueChange={(value) => void save({ annotationScreenshots: value as BrowserSettingsValue['annotationScreenshots'] })}><SelectTrigger className="w-28"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="off">关闭</SelectItem><SelectItem value="ask">每次询问</SelectItem><SelectItem value="always">始终</SelectItem></SelectContent></Select></SettingRow>
    </section>
    <section className="lume-panel-padded"><div className="mb-3 flex items-start gap-3"><KeyRound className="mt-1 text-[var(--brand)]" size={18} /><SectionTitle title="自动填充和密码" description="管理保存的密码、联系信息和 Chrome 手动导入。" /></div><BrowserDataManagers onImport={() => setImportOpen(true)} /></section>
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
function SectionTitle({ title, description }: { title: string; description: string }) { return <div className="mb-3"><h2 className="text-[15px] font-semibold text-[var(--text-1)]">{title}</h2><p className="mt-1 text-[12px] text-[var(--text-3)]">{description}</p></div> }
function normalizeOrigin(value: string): string { try { const url = new URL(value.trim()); return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash ? url.origin : '' } catch { return '' } }
const PERMISSION_LABELS: Record<BrowserSitePermission, string> = { browse: '浏览', download: '下载', upload: '上传', cdp: '完整 CDP', camera: '摄像头', microphone: '麦克风' }
