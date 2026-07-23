import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { browserRuntime } from '@/lib/desktop-api'

type Password = { id: string; origin: string; username: string }
type Contact = { id: string; label: string; fields: string[] }
type Download = { id: string; filename: string; actor: 'user' | 'agent'; state: string; receivedBytes: number; createdAt: string }

export function BrowserDataManagers({ onImport }: { onImport: () => void }) {
  const [dialog, setDialog] = useState<'passwords' | 'contacts' | 'downloads' | 'clear' | null>(null)
  const [passwords, setPasswords] = useState<Password[]>([])
  const [contacts, setContacts] = useState<Contact[]>([])
  const [downloads, setDownloads] = useState<Download[]>([])
  const [contact, setContact] = useState({ label: '', name: '', email: '', phone: '', address: '' })
  const [clearCategories, setClearCategories] = useState({ siteData: true, cache: true, downloads: true, passwords: false })
  const [timeRange, setTimeRange] = useState<'hour' | 'day' | 'all'>('all')

  const open = (kind: typeof dialog) => {
    setDialog(kind)
    if (kind === 'passwords') void browserRuntime<Password[]>({ method: 'vault:list-passwords' }).then(setPasswords)
    if (kind === 'contacts') void browserRuntime<Contact[]>({ method: 'contacts:list' }).then(setContacts)
    if (kind === 'downloads') void browserRuntime<Download[]>({ method: 'downloads:list' }).then(setDownloads)
  }
  const saveContact = () => void browserRuntime<Contact>({ method: 'contacts:upsert', params: contact }).then((saved) => { setContacts((items) => [...items.filter((item) => item.id !== saved.id), saved]); setContact({ label: '', name: '', email: '', phone: '', address: '' }); toast.success('联系信息已加密保存') }).catch(() => toast.error('联系信息保存失败'))
  const clear = () => {
    const categories = Object.entries(clearCategories).filter(([, checked]) => checked).map(([key]) => key)
    void browserRuntime({ method: 'clear-data', params: { categories, timeRange } }).then(() => { toast.success('所选 Lume 浏览数据已清除'); setDialog(null) }).catch(() => toast.error(timeRange === 'all' ? '清理失败' : 'Cookie、站点数据和缓存目前只支持“全部时间”；下载记录支持时间范围'))
  }

  return <>
    <div className="mt-2 flex flex-wrap gap-2"><Button variant="outline" size="sm" onClick={() => open('passwords')}>密码管理</Button><Button variant="outline" size="sm" onClick={() => open('contacts')}>联系人管理</Button><Button variant="outline" size="sm" onClick={() => open('downloads')}>下载历史</Button><Button variant="outline" size="sm" onClick={() => open('clear')}>清除浏览数据</Button><Button variant="outline" size="sm" onClick={onImport}>导入 Cookie 和密码…</Button></div>

    <Dialog open={dialog === 'passwords'} onOpenChange={(value) => !value && setDialog(null)}><DialogContent className="sm:max-w-lg"><DialogHeader><DialogTitle>密码管理器</DialogTitle><DialogDescription>仅显示来源和用户名；Lume 不在设置页展示或复制密码明文。</DialogDescription></DialogHeader><div className="max-h-72 space-y-2 overflow-auto">{passwords.length ? passwords.map((entry) => <div key={entry.id} className="flex items-center justify-between gap-3 rounded-lg border p-3"><div className="min-w-0"><div className="truncate text-sm font-medium">{entry.username}</div><div className="truncate text-xs text-muted-foreground">{entry.origin}</div></div><Button variant="destructive" size="sm" onClick={() => void browserRuntime({ method: 'vault:delete-password', params: { id: entry.id } }).then(() => setPasswords((items) => items.filter((item) => item.id !== entry.id)))}>删除</Button></div>) : <div className="py-8 text-center text-sm text-muted-foreground">尚无保存的密码</div>}</div></DialogContent></Dialog>

    <Dialog open={dialog === 'contacts'} onOpenChange={(value) => !value && setDialog(null)}><DialogContent className="sm:max-w-lg"><DialogHeader><DialogTitle>联系信息</DialogTitle><DialogDescription>姓名、地址、电话和邮箱使用系统安全存储加密。</DialogDescription></DialogHeader><div className="grid gap-2 sm:grid-cols-2"><Input placeholder="标签（必填）" value={contact.label} onChange={(event) => setContact({ ...contact, label: event.target.value })} /><Input placeholder="姓名" value={contact.name} onChange={(event) => setContact({ ...contact, name: event.target.value })} /><Input placeholder="邮箱" value={contact.email} onChange={(event) => setContact({ ...contact, email: event.target.value })} /><Input placeholder="电话" value={contact.phone} onChange={(event) => setContact({ ...contact, phone: event.target.value })} /><Input className="sm:col-span-2" placeholder="地址" value={contact.address} onChange={(event) => setContact({ ...contact, address: event.target.value })} /></div><Button disabled={!contact.label.trim()} onClick={saveContact}>添加联系信息</Button><div className="max-h-48 space-y-2 overflow-auto">{contacts.map((entry) => <div key={entry.id} className="flex items-center justify-between rounded-lg border p-3"><div><div className="text-sm font-medium">{entry.label}</div><div className="text-xs text-muted-foreground">已保存：{entry.fields.join('、')}</div></div><Button variant="destructive" size="sm" onClick={() => void browserRuntime({ method: 'contacts:delete', params: { id: entry.id } }).then(() => setContacts((items) => items.filter((item) => item.id !== entry.id)))}>删除</Button></div>)}</div></DialogContent></Dialog>

    <Dialog open={dialog === 'downloads'} onOpenChange={(value) => !value && setDialog(null)}><DialogContent className="sm:max-w-lg"><DialogHeader><DialogTitle>下载历史</DialogTitle><DialogDescription>历史只包含文件名、状态和非敏感引用，不保存完整路径。</DialogDescription></DialogHeader><div className="max-h-72 space-y-2 overflow-auto">{downloads.length ? downloads.map((entry) => <div key={entry.id} className="rounded-lg border p-3"><div className="truncate text-sm font-medium">{entry.filename}</div><div className="text-xs text-muted-foreground">{entry.actor === 'agent' ? 'Agent' : '用户'} · {entry.state} · {new Date(entry.createdAt).toLocaleString()}</div></div>) : <div className="py-8 text-center text-sm text-muted-foreground">没有下载记录</div>}</div><DialogFooter><Button variant="destructive" disabled={!downloads.length} onClick={() => void browserRuntime({ method: 'downloads:clear' }).then(() => setDownloads([]))}>清除历史</Button></DialogFooter></DialogContent></Dialog>

    <Dialog open={dialog === 'clear'} onOpenChange={(value) => !value && setDialog(null)}><DialogContent><DialogHeader><DialogTitle>清除浏览数据</DialogTitle><DialogDescription>只影响 Lume。保存密码默认不选中，删除时还会出现系统级二次确认。</DialogDescription></DialogHeader><Select value={timeRange} onValueChange={(value) => setTimeRange(value as typeof timeRange)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="hour">过去一小时（仅下载记录）</SelectItem><SelectItem value="day">过去一天（仅下载记录）</SelectItem><SelectItem value="all">全部时间</SelectItem></SelectContent></Select>{Object.entries({ siteData: 'Cookie 和站点数据', cache: '缓存', downloads: '下载记录', passwords: '保存的密码' }).map(([key, label]) => <label key={key} className="flex items-center gap-3 rounded-lg border p-3 text-sm"><Checkbox checked={clearCategories[key as keyof typeof clearCategories]} disabled={timeRange !== 'all' && key !== 'downloads'} onCheckedChange={(checked) => setClearCategories((current) => ({ ...current, [key]: checked === true }))} />{label}</label>)}<DialogFooter><Button variant="outline" onClick={() => setDialog(null)}>取消</Button><Button variant="destructive" onClick={clear}>清除</Button></DialogFooter></DialogContent></Dialog>
  </>
}
