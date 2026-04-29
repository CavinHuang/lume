import * as React from 'react'
import {
  ArrowUpCircle,
  Bell,
  Box,
  CheckCircle2,
  Clock3,
  CloudDownload,
  Download,
  Loader2,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  type LucideIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'

const CURRENT_VERSION = '0.1.0'
const LATEST_VERSION = '0.1.1'
const BUILD_VERSION = '2026.04.29'
const RELEASE_DATE = '2026-04-29'
const LAST_CHECKED_AT = '今天 10:32'

const RELEASE_NOTES = [
  '优化 Agent 会话体验',
  '修复模型供应商配置问题',
  '改进 MCP 设置与稳定性',
]

type UpdateCheckStatus = 'available' | 'checking' | 'latest'

export function UpdateSettings() {
  const [autoCheck, setAutoCheck] = React.useState(true)
  const [restartReminder, setRestartReminder] = React.useState(true)
  const [protectRunningAgent, setProtectRunningAgent] = React.useState(true)
  const [idleInstallOnly, setIdleInstallOnly] = React.useState(true)
  const [status, setStatus] = React.useState<UpdateCheckStatus>('available')

  const handleCheck = () => {
    if (status === 'checking') return
    setStatus('checking')
    window.setTimeout(() => {
      setStatus('available')
      toast.success('已检查到可用更新')
    }, 850)
  }

  const handleDownload = () => {
    toast.info('更新下载能力将在打包更新流水线接入后启用')
  }

  const handleSave = () => {
    toast.success('更新偏好已保存')
  }

  const stats: UpdateStat[] = [
    {
      icon: Box,
      label: '当前版本',
      value: CURRENT_VERSION,
      tone: 'violet',
    },
    {
      icon: CloudDownload,
      label: '最新版本',
      value: LATEST_VERSION,
      tone: 'blue',
    },
    {
      icon: ArrowUpCircle,
      label: '更新状态',
      value: status === 'checking' ? '检查中' : status === 'latest' ? '已最新' : '可更新',
      tone: 'green',
      valueClassName: status === 'available' ? 'text-[#15b365]' : undefined,
    },
    {
      icon: Clock3,
      label: '上次检查',
      value: LAST_CHECKED_AT,
      tone: 'purple',
    },
  ]

  return (
    <div className="space-y-4 pb-6">
      <div className="grid grid-cols-4 gap-3">
        {stats.map((item) => (
          <UpdateStatCard key={item.label} item={item} />
        ))}
      </div>

      <VersionCard />

      <UpdateDetailsCard
        status={status}
        onCheck={handleCheck}
        onDownload={handleDownload}
      />

      <div className="grid grid-cols-2 gap-3">
        <OptionCard title="更新选项">
          <OptionRow
            icon={RefreshCw}
            label="自动检查更新"
            desc="定期检查是否有新版本可用"
            checked={autoCheck}
            onCheckedChange={setAutoCheck}
          />
          <OptionRow
            icon={Bell}
            label="下载完成后提醒重启"
            desc="下载完成后在系统托盘通知"
            checked={restartReminder}
            onCheckedChange={setRestartReminder}
          />
        </OptionCard>

        <OptionCard title="安装保护">
          <OptionRow
            icon={ShieldCheck}
            label="Agent 运行中不自动重启"
            desc="避免在任务执行中中断工作"
            checked={protectRunningAgent}
            onCheckedChange={setProtectRunningAgent}
          />
          <OptionRow
            icon={CheckCircle2}
            label="仅在空闲时提示安装"
            desc="减少对当前工作的打扰"
            checked={idleInstallOnly}
            onCheckedChange={setIdleInstallOnly}
          />
        </OptionCard>
      </div>

      <div className="sticky bottom-0 -mx-1 flex justify-end gap-2 border-t border-[var(--border)] bg-[var(--background)]/95 px-1 pt-4 backdrop-blur">
        <Button
          type="button"
          variant="outline"
          className="h-9 min-w-[120px] rounded-[8px] border-[var(--border)] bg-[var(--surface-1)] text-[13px] font-medium text-[var(--text-2)] shadow-none hover:bg-[var(--surface-2)]"
        >
          取消
        </Button>
        <Button
          type="button"
          onClick={handleSave}
          className="h-9 min-w-[128px] rounded-[8px] bg-gradient-to-r from-[#6d5df6] to-[#7c5cff] px-5 text-[13px] font-semibold text-white shadow-[0_10px_22px_rgba(109,93,246,0.20)] hover:from-[#5f52e8] hover:to-[#704ff2]"
        >
          保存更改
        </Button>
      </div>
    </div>
  )
}

type UpdateStat = {
  icon: LucideIcon
  label: string
  value: string
  tone: 'violet' | 'blue' | 'green' | 'purple'
  valueClassName?: string
}

function UpdateStatCard({ item }: { item: UpdateStat }) {
  const Icon = item.icon
  return (
    <section className="flex min-h-[88px] items-center gap-3 rounded-[10px] border border-[var(--border)] bg-[var(--surface-1)] px-4 py-3 shadow-[0_1px_2px_rgba(20,24,40,0.02)]">
      <div
        className={cn(
          'flex size-11 shrink-0 items-center justify-center rounded-full',
          item.tone === 'violet' && 'bg-[#f0edff] text-[#6d5df6]',
          item.tone === 'blue' && 'bg-[#eaf4ff] text-[#2487ff]',
          item.tone === 'green' && 'bg-[#ddf9e8] text-[#13a85a]',
          item.tone === 'purple' && 'bg-[#f1ecff] text-[#7c5cff]'
        )}
      >
        <Icon size={20} strokeWidth={1.9} />
      </div>
      <div className="min-w-0">
        <div className="text-[12px] font-medium leading-4 text-[var(--text-3)]">{item.label}</div>
        <div className={cn('mt-1 text-[18px] font-semibold leading-6 text-[var(--text-1)]', item.valueClassName)}>
          {item.value}
        </div>
      </div>
    </section>
  )
}

function VersionCard() {
  return (
    <section className="rounded-[10px] border border-[var(--border)] bg-[var(--surface-1)] px-5 py-4 shadow-[0_1px_2px_rgba(20,24,40,0.02)]">
      <h3 className="text-[16px] font-semibold leading-6 text-[var(--text-1)]">当前版本</h3>
      <div className="mt-4 grid grid-cols-[minmax(0,1fr)_1px_360px] items-center gap-8">
        <div className="flex items-center gap-5">
          <div className="flex size-[88px] shrink-0 items-center justify-center rounded-[18px] bg-gradient-to-br from-[#7967ff] via-[#6655e8] to-[#18236f] text-white shadow-[0_14px_28px_rgba(105,90,238,0.25)]">
            <Sparkles size={44} strokeWidth={1.7} />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h4 className="text-[22px] font-semibold leading-7 text-[var(--text-1)]">Lume</h4>
              <span className="rounded-full bg-[color-mix(in_oklab,var(--brand)_12%,var(--surface-1))] px-2.5 py-1 text-[12px] font-semibold text-[var(--brand)]">
                稳定版
              </span>
            </div>
            <p className="mt-2 text-[13px] leading-5 text-[var(--text-2)]">本地优先的 AI Agent 应用</p>
          </div>
        </div>

        <div className="h-[112px] bg-[var(--border)]" />

        <dl className="space-y-3">
          <InfoRow label="当前版本" value={CURRENT_VERSION} />
          <InfoRow label="构建版本" value={BUILD_VERSION} />
          <InfoRow label="更新通道" value="Stable" />
          <InfoRow label="安装方式" value="桌面应用" />
        </dl>
      </div>
    </section>
  )
}

function UpdateDetailsCard({
  status,
  onCheck,
  onDownload,
}: {
  status: UpdateCheckStatus
  onCheck: () => void
  onDownload: () => void
}) {
  const checking = status === 'checking'

  return (
    <section className="rounded-[10px] border border-[var(--border)] bg-[var(--surface-1)] px-5 py-4 shadow-[0_1px_2px_rgba(20,24,40,0.02)]">
      <h3 className="text-[16px] font-semibold leading-6 text-[var(--text-1)]">更新详情</h3>
      <div className="mt-4 flex items-center gap-3">
        <span className="inline-flex h-7 items-center gap-1.5 rounded-[8px] bg-[#e2f8eb] px-3 text-[13px] font-semibold text-[#12a15a]">
          <ArrowUpCircle size={15} />
          Lume {LATEST_VERSION} 可用
        </span>
        <span className="text-[13px] leading-5 text-[var(--text-3)]">发布于 {RELEASE_DATE}</span>
      </div>

      <p className="mt-4 max-w-[720px] text-[13px] leading-6 text-[var(--text-2)]">
        此更新优化了稳定性与用户体验，建议尽快更新以获得更好的使用体验。
      </p>

      <ul className="mt-2 space-y-1 text-[13px] leading-6 text-[var(--text-1)]">
        {RELEASE_NOTES.map((note) => (
          <li key={note} className="flex gap-2">
            <span className="mt-[9px] size-1 rounded-full bg-[var(--text-3)]" />
            <span>{note}</span>
          </li>
        ))}
      </ul>

      <div className="mt-5 flex items-center justify-between gap-4">
        <div className="text-[13px] leading-5 text-[var(--text-3)]">上次检查：{LAST_CHECKED_AT}</div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={checking}
            onClick={onCheck}
            className="h-9 min-w-[128px] rounded-[8px] border-[var(--border)] bg-[var(--surface-1)] text-[13px] font-medium text-[var(--text-2)] shadow-none hover:bg-[var(--surface-2)] disabled:opacity-70"
          >
            {checking ? <Loader2 size={15} className="animate-spin" /> : <RotateCcw size={15} />}
            检查更新
          </Button>
          <Button
            type="button"
            onClick={onDownload}
            className="h-9 min-w-[132px] rounded-[8px] bg-gradient-to-r from-[#6d5df6] to-[#7c5cff] px-5 text-[13px] font-semibold text-white shadow-[0_10px_22px_rgba(109,93,246,0.20)] hover:from-[#5f52e8] hover:to-[#704ff2]"
          >
            <Download size={15} />
            下载更新
          </Button>
        </div>
      </div>
    </section>
  )
}

function OptionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-[10px] border border-[var(--border)] bg-[var(--surface-1)] px-5 py-4 shadow-[0_1px_2px_rgba(20,24,40,0.02)]">
      <h3 className="text-[16px] font-semibold leading-6 text-[var(--text-1)]">{title}</h3>
      <div className="mt-3 divide-y divide-[var(--border)]">{children}</div>
    </section>
  )
}

function OptionRow({
  icon: Icon,
  label,
  desc,
  checked,
  onCheckedChange,
}: {
  icon: LucideIcon
  label: string
  desc: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <div className="flex min-h-[56px] items-center justify-between gap-5 py-2">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-[8px] bg-[var(--surface-2)] text-[var(--text-2)]">
          <Icon size={15} />
        </div>
        <div className="min-w-0">
          <div className="text-[13px] font-medium leading-5 text-[var(--text-1)]">{label}</div>
          <div className="mt-0.5 text-[12px] leading-4 text-[var(--text-3)]">{desc}</div>
        </div>
      </div>
      <LumeSwitch checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  )
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-6 text-[13px] leading-5">
      <dt className="text-[var(--text-3)]">{label}</dt>
      <dd className="font-semibold text-[var(--text-1)]">{value}</dd>
    </div>
  )
}

function LumeSwitch(props: React.ComponentProps<typeof Switch>) {
  return (
    <Switch
      {...props}
      className={cn(
        'data-[size=default]:h-[25px] data-[size=default]:w-[42px] data-checked:bg-[var(--brand)]',
        '[&_[data-slot=switch-thumb]]:size-[21px] data-checked:[&_[data-slot=switch-thumb]]:translate-x-[19px]'
      )}
    />
  )
}
