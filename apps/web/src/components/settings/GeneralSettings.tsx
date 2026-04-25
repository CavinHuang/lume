import * as React from 'react'
import { useAtom } from 'jotai'
import {
  ChevronDown,
  ExternalLink,
  Folder,
  Keyboard,
  Languages,
  RefreshCcw,
  Trash2,
  type LucideIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { agentWorkspacesAtom, currentWorkspaceIdAtom } from '@/atoms'
import { openLumeConfigSourceFile } from '@/lib/desktop-api/lume-config'
import { cn } from '@/lib/utils'
import { ClearCacheDialog } from './ClearCacheDialog'

type DefaultPage = 'home' | 'recent' | 'workspace'

export function GeneralSettings() {
  const [workspaces] = useAtom(agentWorkspacesAtom)
  const [currentWorkspaceId, setCurrentWorkspaceId] = useAtom(currentWorkspaceIdAtom)
  const [defaultPage, setDefaultPage] = React.useState<DefaultPage>('home')
  const [restoreLastSession, setRestoreLastSession] = React.useState(true)
  const [autoSync, setAutoSync] = React.useState(true)
  const [desktopNotice, setDesktopNotice] = React.useState(true)
  const [taskNotice, setTaskNotice] = React.useState(true)
  const [updateNotice, setUpdateNotice] = React.useState(true)
  const [clearCacheOpen, setClearCacheOpen] = React.useState(false)

  const currentWorkspace = React.useMemo(
    () => workspaces.find((item) => item.id === currentWorkspaceId) ?? workspaces[0] ?? null,
    [currentWorkspaceId, workspaces]
  )

  return (
    <>
      <div className="space-y-3">
        <SettingsCard title="账户与工作区">
          <div className="flex items-center gap-3 border-b border-[#eef0f5] pb-5">
            <div className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-full bg-[linear-gradient(135deg,#d7c9b5,#f1e5d8)] text-[15px] font-semibold text-[#3f4555]">
              M
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[14px] font-semibold leading-5 text-[#283046]">Minator Huang</div>
              <div className="mt-0.5 text-[12px] leading-4 text-[#8a91a6]">minator.huang@example.com</div>
            </div>
            <button
              type="button"
              className="flex h-10 items-center gap-2 rounded-[8px] border border-[#e4e7ef] bg-white px-4 text-[13px] font-medium text-[#4c566f] shadow-[0_1px_2px_rgba(20,24,40,0.02)] transition-colors hover:bg-[#f8f9fc]"
            >
              管理账户
              <ExternalLink size={15} strokeWidth={1.8} />
            </button>
          </div>

          <div className="divide-y divide-[#eef0f5]">
            <SettingsRow label="默认工作区">
              <SelectShell className="w-[136px]">
                <select
                  value={currentWorkspace?.id ?? ''}
                  onChange={(event) => setCurrentWorkspaceId(event.target.value || null)}
                  className="h-full w-full appearance-none bg-transparent pl-3 pr-8 text-[13px] font-medium text-[#4c566f] outline-none"
                >
                  {workspaces.length === 0 ? (
                    <option value="">未选择</option>
                  ) : workspaces.map((workspace) => (
                    <option key={workspace.id} value={workspace.id}>{workspace.name}</option>
                  ))}
                </select>
              </SelectShell>
            </SettingsRow>

            <SettingsRow
              label="启动时打开上次会话"
              desc="应用启动后自动恢复到上次查看的会话"
            >
              <LumeSwitch checked={restoreLastSession} onCheckedChange={setRestoreLastSession} />
            </SettingsRow>

            <SettingsRow
              label="自动同步"
              desc="自动同步会话、文件与设置到云端"
            >
              <LumeSwitch checked={autoSync} onCheckedChange={setAutoSync} />
            </SettingsRow>
          </div>
        </SettingsCard>

        <SettingsCard title="基础偏好">
          <div className="divide-y divide-[#eef0f5]">
            <SettingsRow label="语言" icon={Languages}>
              <SelectShell className="w-[136px]">
                <select className="h-full w-full appearance-none bg-transparent pl-3 pr-8 text-[13px] font-medium text-[#4c566f] outline-none" defaultValue="zh-CN">
                  <option value="zh-CN">简体中文</option>
                  <option value="en-US">English</option>
                </select>
              </SelectShell>
            </SettingsRow>

            <SettingsRow label="默认页面">
              <div className="grid h-9 w-[252px] grid-cols-3 rounded-[8px] border border-[#e3e6ee] bg-white p-0.5">
                {[
                  ['home', '首页'],
                  ['recent', '最近会话'],
                  ['workspace', '工作区'],
                ].map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setDefaultPage(value as DefaultPage)}
                    className={cn(
                      'rounded-[6px] text-[13px] font-medium transition-colors',
                      defaultPage === value
                        ? 'border border-[#9f91ff] bg-[#f5f2ff] text-[#625bff]'
                        : 'text-[#667089] hover:bg-[#f7f8fb]'
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </SettingsRow>

            <SettingsRow label="时间格式">
              <SelectShell className="w-[120px]">
                <select className="h-full w-full appearance-none bg-transparent pl-3 pr-8 text-[13px] font-medium text-[#4c566f] outline-none" defaultValue="24">
                  <option value="24">24 小时</option>
                  <option value="12">12 小时</option>
                </select>
              </SelectShell>
            </SettingsRow>
          </div>
        </SettingsCard>

        <SettingsCard title="通知">
          <div className="divide-y divide-[#eef0f5]">
            <SettingsRow label="桌面通知" desc="接收新消息、任务完成等桌面通知">
              <LumeSwitch checked={desktopNotice} onCheckedChange={setDesktopNotice} />
            </SettingsRow>
            <SettingsRow label="任务完成提醒" desc="任务成功完成时发送通知提醒">
              <LumeSwitch checked={taskNotice} onCheckedChange={setTaskNotice} />
            </SettingsRow>
            <SettingsRow label="系统更新提醒" desc="有新版本或重要更新时提醒我">
              <LumeSwitch checked={updateNotice} onCheckedChange={setUpdateNotice} />
            </SettingsRow>
          </div>
        </SettingsCard>

        <SettingsCard title="快速操作">
          <div className="grid grid-cols-4 gap-3">
            <QuickAction icon={Keyboard} label="管理快捷键" />
            <QuickAction icon={Folder} label="打开数据目录" onClick={() => void openLumeConfigSourceFile()} />
            <QuickAction icon={RefreshCcw} label="检查更新" />
            <QuickAction
              icon={Trash2}
              label="重置偏好"
              tone="danger"
              onClick={() => setClearCacheOpen(true)}
            />
          </div>
        </SettingsCard>
      </div>

      <ClearCacheDialog open={clearCacheOpen} onOpenChange={setClearCacheOpen} />
    </>
  )
}

function SettingsCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-[10px] border border-[#e7e9f1] bg-white px-5 py-4 shadow-[0_1px_2px_rgba(20,24,40,0.02)]">
      <h2 className="mb-3 text-[16px] font-semibold leading-6 text-[#202338]">{title}</h2>
      {children}
    </section>
  )
}

function SettingsRow({
  label,
  desc,
  icon: Icon,
  children,
}: {
  label: string
  desc?: string
  icon?: LucideIcon
  children: React.ReactNode
}) {
  return (
    <div className="flex min-h-[48px] items-center justify-between gap-5 py-2">
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-[13px] font-medium leading-5 text-[#4d566f]">
          {Icon && <Icon size={15} className="text-[#68718a]" />}
          <span>{label}</span>
        </div>
        {desc && <div className="mt-0.5 text-[12px] leading-4 text-[#9aa1b3]">{desc}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

function SelectShell({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={cn('relative h-9 rounded-[8px] border border-[#e3e6ee] bg-white', className)}>
      {children}
      <ChevronDown
        size={15}
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[#778096]"
      />
    </div>
  )
}

function LumeSwitch(props: React.ComponentProps<typeof Switch>) {
  return (
    <Switch
      {...props}
      className={cn(
        'data-[size=default]:h-[25px] data-[size=default]:w-[42px] data-checked:bg-[#625bff]',
        '[&_[data-slot=switch-thumb]]:size-[21px] data-checked:[&_[data-slot=switch-thumb]]:translate-x-[19px]'
      )}
    />
  )
}

function QuickAction({
  icon: Icon,
  label,
  tone = 'default',
  onClick,
}: {
  icon: LucideIcon
  label: string
  tone?: 'default' | 'danger'
  onClick?: () => void
}) {
  return (
    <Button
      type="button"
      variant="outline"
      onClick={onClick}
      className={cn(
        'h-10 gap-2 rounded-[8px] border-[#e3e6ee] bg-white text-[13px] font-medium text-[#4d566f] shadow-none hover:bg-[#f8f9fc]',
        tone === 'danger' && 'border-[#ff9fa8] text-[#ff4d57] hover:bg-[#fff5f6] hover:text-[#ff4d57]'
      )}
    >
      <Icon size={15} />
      {label}
    </Button>
  )
}
