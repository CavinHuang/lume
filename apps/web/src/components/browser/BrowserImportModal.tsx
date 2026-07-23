import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cancelChromeImport, discoverChromeProfiles, onBrowserEvent, startChromeImport } from '@/lib/desktop-api'

type Profile = { id: string; name: string; platform: 'win32' | 'darwin'; hasCookies: boolean; hasPasswords: boolean }
type Report = { imported?: { cookies?: number; passwords?: number }; skipped?: { cookies?: number; passwords?: number }; failed?: { cookies?: number; passwords?: number }; reasons?: Record<string, number>; errors?: string[] }

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
    void discoverChromeProfiles().then((items) => { setProfiles(items); if (!profileId) setProfileId(items[0]?.id ?? '') }).catch(() => setProfiles([]))
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
  const busy = Boolean(jobId)
  const valid = Boolean(profileId && (cookies || passwords) && acknowledged)
  const start = async () => {
    if (!valid) return
    setError(''); setPhase('准备在线快照')
    try { const result = await startChromeImport({ profileId, cookies, passwords, acknowledged: true }); setJobId(result.jobId) } catch (cause) { setError(cause instanceof Error ? cause.message : '导入失败') }
  }
  const cancel = async () => { if (!jobId) return; await cancelChromeImport(jobId).catch(() => undefined); setPhase('正在取消并清理快照…') }
  return <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next) }}>
    <DialogContent>
      <DialogHeader><DialogTitle>导入 Chrome Cookie 和密码</DialogTitle><DialogDescription>Chrome 可以保持运行。Lume 使用在线快照和系统保护边界；不会把明文凭据写入设置、日志或 Agent。</DialogDescription></DialogHeader>
      <div className="space-y-4 py-2">
        <Select value={profileId} onValueChange={(value) => setProfileId(value ?? '')}><SelectTrigger><SelectValue placeholder={profiles.length ? '选择 Chrome 配置文件' : '未发现 Windows/macOS Chrome 配置文件'} /></SelectTrigger><SelectContent>{profiles.map((profile) => <SelectItem key={profile.id} value={profile.id}>{profile.name} · {profile.platform === 'win32' ? 'Windows' : 'macOS'}</SelectItem>)}</SelectContent></Select>
        <div className="flex gap-5 text-sm"><label className="flex items-center gap-2"><Checkbox checked={cookies} onCheckedChange={(checked) => setCookies(checked === true)} />Cookie</label><label className="flex items-center gap-2"><Checkbox checked={passwords} onCheckedChange={(checked) => setPasswords(checked === true)} />密码</label></div>
        <label className="flex items-start gap-2 text-xs text-muted-foreground"><Checkbox checked={acknowledged} onCheckedChange={(checked) => setAcknowledged(checked === true)} /><span>我确认允许 Lume 请求系统 Keychain/DPAPI 保护边界，并将数据导入当前 Lume 用户配置。</span></label>
        {phase && <p className="text-xs text-primary">{phase}</p>}
        {error && <p className="text-xs text-destructive">{error}</p>}
        {report && <div className="rounded-md border p-3 text-xs"><div>已导入：Cookie {report.imported?.cookies ?? 0}，密码 {report.imported?.passwords ?? 0}</div><div>跳过：Cookie {report.skipped?.cookies ?? 0}，密码 {report.skipped?.passwords ?? 0}</div><div>失败：Cookie {report.failed?.cookies ?? 0}，密码 {report.failed?.passwords ?? 0}</div>{Object.entries(report.reasons ?? {}).map(([reason, count]) => <div key={reason} className="mt-1 text-muted-foreground">{reason}：{count}</div>)}{(report.errors?.length ?? 0) > 0 && <div className="mt-1 text-destructive">部分失败：{report.errors?.join('、')}</div>}</div>}
      </div>
      <DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>关闭</Button>{busy ? <Button variant="destructive" onClick={() => void cancel()}>取消并清理</Button> : <><Button variant="outline" onClick={() => void start()} disabled={!valid}>导入</Button>{report && <Button onClick={() => void start()} disabled={!valid}>重试</Button>}</>}</DialogFooter>
    </DialogContent>
  </Dialog>
}
