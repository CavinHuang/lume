import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cancelChromeImport, discoverChromeProfiles, onBrowserEvent, startChromeImport } from '@/lib/desktop-api'

type Profile = { id: string; name: string; platform: 'win32' | 'darwin' | 'linux'; source: 'local' | 'connected'; hasCookies: boolean; hasPasswords: boolean }
type Report = { imported?: { cookies?: number; passwords?: number }; skipped?: { cookies?: number; passwords?: number }; failed?: { cookies?: number; passwords?: number }; reasons?: Record<string, number>; errors?: string[]; cookieSource?: 'chrome_extension' | 'local_database' }

export function BrowserImportModal({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [profileId, setProfileId] = useState('')
  const [cookies, setCookies] = useState(true)
  const [passwords, setPasswords] = useState(true)
  const [acknowledged, setAcknowledged] = useState(false)
  const [jobId, setJobId] = useState('')
  const [phase, setPhase] = useState('')
  const [report, setReport] = useState<Report | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    setReport(null); setError(''); setAcknowledged(false)
    void discoverChromeProfiles().then((items) => {
      setProfiles(items)
      const selected = items.find((item) => item.id === profileId) ?? items[0]
      setProfileId(selected?.id ?? '')
      setCookies(selected?.hasCookies === true)
      setPasswords(selected?.hasPasswords === true)
    }).catch(() => setProfiles([]))
  }, [open])
  useEffect(() => {
    let dispose: (() => void) | undefined; let disposed = false
    void onBrowserEvent((event) => {
      if (!jobId || event.params.jobId !== jobId) return
      if (event.method === 'browser:import-progress') setPhase(typeof event.params.phase === 'string' ? event.params.phase : '导入中')
      if (event.method === 'browser:import-complete') { setJobId(''); setPhase(''); setReport(event.params.report as Report | undefined ?? null); setError(typeof event.params.error === 'string' ? event.params.error : '') }
    }).then((stop) => { if (disposed) stop(); else dispose = stop })
    return () => { disposed = true; dispose?.() }
  }, [jobId])
  const selectedProfile = profiles.find((profile) => profile.id === profileId)
  const busy = Boolean(jobId)
  const valid = Boolean(selectedProfile && ((cookies && selectedProfile.hasCookies) || (passwords && selectedProfile.hasPasswords)) && acknowledged)
  const selectProfile = (value: string) => {
    const selected = profiles.find((profile) => profile.id === value)
    setProfileId(value)
    setCookies(selected?.hasCookies === true)
    setPasswords(selected?.hasPasswords === true)
  }
  const start = async () => {
    if (!valid) return
    setError(''); setPhase(selectedProfile?.source === 'connected' ? '正在从已连接的 Chrome 读取 Cookie' : '准备在线快照')
    try { const result = await startChromeImport({ profileId, cookies, passwords, acknowledged: true }); setJobId(result.jobId) } catch (cause) { setError(cause instanceof Error ? cause.message : '导入失败') }
  }
  const cancel = async () => { if (!jobId) return; await cancelChromeImport(jobId).catch(() => undefined); setPhase('正在取消并清理导入数据…') }
  return <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next) }}>
    <DialogContent>
      <DialogHeader><DialogTitle>导入 Chrome 登录数据</DialogTitle><DialogDescription>{selectedProfile?.source === 'connected' ? '从当前已连接的 Chrome 安全导入 Cookie，可兼容 Chrome 最新的应用绑定保护。分区 Cookie、Passkey 和设备绑定会话不会迁移。' : '兼容导入会读取本地 Profile 快照；Chrome 可以保持运行，但受应用绑定保护的 Cookie 和密码可能无法迁移。'}</DialogDescription></DialogHeader>
      <div className="space-y-4 py-2">
        <Select value={profileId} onValueChange={(value) => selectProfile(value ?? '')}><SelectTrigger><SelectValue placeholder={profiles.length ? '选择 Chrome 数据来源' : '未发现可导入的 Chrome 数据'} /></SelectTrigger><SelectContent>{profiles.map((profile) => <SelectItem key={profile.id} value={profile.id}>{profile.name} · {profile.source === 'connected' ? '推荐' : profile.platform === 'win32' ? 'Windows 兼容导入' : profile.platform === 'darwin' ? 'macOS 兼容导入' : 'Linux 兼容导入'}</SelectItem>)}</SelectContent></Select>
        <div className="flex gap-5 text-sm"><label className="flex items-center gap-2"><Checkbox disabled={!selectedProfile?.hasCookies} checked={cookies} onCheckedChange={(checked) => setCookies(checked === true)} />Cookie</label><label className="flex items-center gap-2"><Checkbox disabled={!selectedProfile?.hasPasswords} checked={passwords} onCheckedChange={(checked) => setPasswords(checked === true)} />密码</label></div>
        <label className="flex items-start gap-2 text-xs text-muted-foreground"><Checkbox checked={acknowledged} onCheckedChange={(checked) => setAcknowledged(checked === true)} /><span>{selectedProfile?.source === 'connected' ? '我确认将当前 Chrome Profile 中可迁移的 Cookie 导入 Lume 浏览器。' : '我确认允许 Lume 请求系统 Keychain/DPAPI 保护边界，并将数据导入当前 Lume 用户配置。'}</span></label>
        {phase && <p className="text-xs text-primary">{phase}</p>}
        {error && <p className="text-xs text-destructive">{error}</p>}
        {report && <div className="rounded-md border p-3 text-xs"><div>已导入：Cookie {report.imported?.cookies ?? 0}，密码 {report.imported?.passwords ?? 0}</div><div>跳过：Cookie {report.skipped?.cookies ?? 0}，密码 {report.skipped?.passwords ?? 0}</div><div>失败：Cookie {report.failed?.cookies ?? 0}，密码 {report.failed?.passwords ?? 0}</div>{report.cookieSource && <div className="mt-1 text-muted-foreground">来源：{report.cookieSource === 'chrome_extension' ? '当前已连接的 Chrome' : '本地 Profile 兼容导入'}</div>}{Object.entries(report.reasons ?? {}).map(([reason, count]) => <div key={reason} className="mt-1 text-muted-foreground">{REASON_LABELS[reason] ?? reason}：{count}</div>)}{(report.errors?.length ?? 0) > 0 && <div className="mt-1 text-destructive">部分失败：{report.errors?.map((error) => REASON_LABELS[error] ?? error).join('、')}</div>}</div>}
      </div>
      <DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>关闭</Button>{busy ? <Button variant="destructive" onClick={() => void cancel()}>取消并清理</Button> : <><Button variant="outline" onClick={() => void start()} disabled={!valid}>导入</Button>{report && <Button onClick={() => void start()} disabled={!valid}>重试</Button>}</>}</DialogFooter>
    </DialogContent>
  </Dialog>
}

const REASON_LABELS: Record<string, string> = {
  app_bound_cookie_unsupported: '受 Chrome 应用绑定保护，无法兼容导入',
  partitioned_cookie_unsupported: '分区 Cookie 暂不支持',
  cookie_decrypt_unavailable: 'Cookie 无法解密',
  cookie_invalid: 'Cookie 已过期或格式不兼容',
  expired_cookie: 'Cookie 已过期',
  cookies_snapshot_or_decrypt_failed: 'Cookie 快照或解密失败',
  passwords_snapshot_or_keychain_failed: '密码快照或系统密钥访问失败',
  browser_unavailable: '当前 Chrome 连接不可用，请确认扩展和 Native Host 已连接',
  connected_chrome_export_invalid: 'Chrome 返回了无效的导入数据',
}
