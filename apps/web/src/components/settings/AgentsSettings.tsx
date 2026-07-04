import * as React from 'react'
import {
  Boxes,
  Brain,
  ChevronRight,
  Clock3,
  LockKeyhole,
  Search,
  Sparkles,
  UnlockKeyhole,
  X,
  type LucideIcon,
} from 'lucide-react'
import {
  BUILTIN_AGENT_ROLES,
  canAgentRolesRunInParallel,
  type AgentRoleDefinition,
} from '@lume/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import {
  AGENT_ROLE_ASSETS,
  buildAgentRoleMetrics,
  buildAgentRoleRecommendationPreview,
  filterAgentRoles,
} from './agents-settings-state'

export function AgentsSettings() {
  const [query, setQuery] = React.useState('')
  const [recommendationInput, setRecommendationInput] = React.useState('做一个 PPT dashboard 数据可视化页面')
  const [selectedRoleId, setSelectedRoleId] = React.useState(BUILTIN_AGENT_ROLES[0]?.id ?? 'researcher')

  const filteredRoles = React.useMemo(() => filterAgentRoles(query), [query])
  const selectedRole = BUILTIN_AGENT_ROLES.find((role) => role.id === selectedRoleId) ?? filteredRoles[0] ?? BUILTIN_AGENT_ROLES[0]
  const metrics = React.useMemo(() => buildAgentRoleMetrics(), [])
  const recommendations = React.useMemo(
    () => buildAgentRoleRecommendationPreview(recommendationInput),
    [recommendationInput]
  )

  React.useEffect(() => {
    if (!filteredRoles.some((role) => role.id === selectedRoleId) && filteredRoles[0]) {
      setSelectedRoleId(filteredRoles[0].id)
    }
  }, [filteredRoles, selectedRoleId])

  return (
    <div className="space-y-3">
      <section className="lume-panel overflow-hidden">
        <div className="grid min-h-[154px] grid-cols-[minmax(0,1fr)_260px]">
          <div className="p-5">
            <div className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.08em] text-[var(--brand)]">
              <Sparkles size={14} />
              Lume Agents
            </div>
            <h2 className="mt-2 text-[22px] font-semibold leading-7 text-[var(--text-1)]">内置角色团队</h2>
            <p className="mt-2 max-w-[640px] text-[13px] leading-6 text-[var(--text-2)]">
              复刻 Alice 的 11 个专业角色，并通过共享 registry 同时驱动设置页、推荐关键词和子 Agent 运行时身份。
            </p>
            <div className="mt-4 grid grid-cols-4 gap-2">
              {metrics.map((metric) => (
                <div key={metric.label} className="lume-subpanel px-3 py-2">
                  <div className="text-[11px] font-medium text-[var(--text-3)]">{metric.label}</div>
                  <div className="mt-1 text-[18px] font-semibold leading-5 text-[var(--text-1)]">{metric.value}</div>
                </div>
              ))}
            </div>
          </div>
          <div className="relative overflow-hidden border-l border-[var(--border)] bg-[var(--surface-2)]">
            <img
              src={AGENT_ROLE_ASSETS.team}
              alt=""
              className="h-full w-full object-cover"
            />
          </div>
        </div>
      </section>

      <section className="grid min-h-[520px] grid-cols-[minmax(0,1fr)_340px] gap-3">
        <div className="lume-panel min-w-0 p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-[16px] font-semibold leading-6 text-[var(--text-1)]">角色目录</h3>
              <p className="text-[12px] leading-5 text-[var(--text-3)]">按姓名、职能、Skill、关键词快速筛选。</p>
            </div>
            <div className="relative w-[260px]">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-3)]" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索 agents"
                className="h-9 rounded-[8px] pl-9 text-[13px]"
              />
            </div>
          </div>

          <div className="mt-4 grid grid-cols-3 gap-3">
            {filteredRoles.map((role) => (
              <AgentRoleCard
                key={role.id}
                role={role}
                selected={role.id === selectedRole?.id}
                onSelect={() => setSelectedRoleId(role.id)}
              />
            ))}
          </div>

          {filteredRoles.length === 0 && (
            <div className="mt-4 flex h-[220px] items-center justify-center rounded-[9px] border border-dashed border-[var(--border)] text-[13px] text-[var(--text-3)]">
              没有匹配的角色
            </div>
          )}

          <div className="mt-4 rounded-[9px] border border-[var(--border)] bg-[var(--surface-2)] p-3">
            <div className="flex items-center gap-2 text-[13px] font-semibold text-[var(--text-1)]">
              <Brain size={15} />
              任务推荐预览
            </div>
            <div className="mt-3 grid grid-cols-[minmax(0,1fr)_auto] gap-2">
              <Input
                value={recommendationInput}
                onChange={(event) => setRecommendationInput(event.target.value)}
                placeholder="输入一句任务，查看推荐角色"
                className="h-9 rounded-[8px] text-[13px]"
              />
              <Button type="button" variant="outline" className="h-9 rounded-[8px]" onClick={() => setRecommendationInput('')}>
                <X size={14} />
              </Button>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {recommendations.length > 0 ? recommendations.slice(0, 5).map((item) => (
                <Button
                variant="ghost"
                  key={item.role.id}
                  type="button"
                  onClick={() => setSelectedRoleId(item.role.id)}
                  className="lume-action-tile h-auto justify-start px-3 py-2 text-left text-[12px] shadow-none"
                >
                  <span className="font-semibold text-[var(--text-1)]">{item.label}</span>
                  <span className="ml-2 text-[var(--text-3)]">命中 {item.score}</span>
                </Button>
              )) : (
                <span className="text-[12px] text-[var(--text-3)]">暂无推荐</span>
              )}
            </div>
          </div>
        </div>

        {selectedRole && <AgentRoleDetail role={selectedRole} />}
      </section>
    </div>
  )
}

function AgentRoleCard({
  role,
  selected,
  onSelect,
}: {
  role: AgentRoleDefinition
  selected: boolean
  onSelect: () => void
}) {
  return (
    <Button
                variant="ghost"
      type="button"
      onClick={onSelect}
      className={cn(
        'group h-auto w-full flex-col items-stretch justify-start gap-0 overflow-hidden rounded-[9px] border bg-[var(--surface-1)] p-0 text-left whitespace-normal transition-colors',
        selected
          ? 'border-[color-mix(in_oklab,var(--brand)_45%,var(--border))] ring-2 ring-[color-mix(in_oklab,var(--brand)_12%,transparent)]'
          : 'border-[var(--border)] hover:border-[color-mix(in_oklab,var(--brand)_35%,var(--border))]'
      )}
    >
      <div className="aspect-[4/3] overflow-hidden bg-[var(--surface-2)]">
        <img src={AGENT_ROLE_ASSETS.roles[role.id]} alt="" className="h-full w-full object-cover transition-transform group-hover:scale-[1.03]" />
      </div>
      <div className="p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate text-[14px] font-semibold text-[var(--text-1)]">{role.displayName}</div>
            <div className="truncate text-[11px] font-medium text-[var(--text-3)]">{role.name} · {role.id}</div>
          </div>
          <ChevronRight size={15} className="mt-0.5 shrink-0 text-[var(--text-3)]" />
        </div>
        <p className="mt-2 line-clamp-2 min-h-10 text-[12px] leading-5 text-[var(--text-2)]">{role.description}</p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          <RoleBadge>{role.title}</RoleBadge>
          <RoleBadge>{role.concurrency.defaultReadOnly ? '只读' : '可写'}</RoleBadge>
          {role.defaultBackground && <RoleBadge>后台</RoleBadge>}
        </div>
      </div>
    </Button>
  )
}

function AgentRoleDetail({ role }: { role: AgentRoleDefinition }) {
  const parallelRoles = BUILTIN_AGENT_ROLES.filter((item) => item.id !== role.id && canAgentRolesRunInParallel(role.id, item.id))
  const conflictRoles = BUILTIN_AGENT_ROLES.filter((item) => item.id !== role.id && !canAgentRolesRunInParallel(role.id, item.id))

  return (
    <aside className="lume-panel min-w-0 overflow-hidden">
      <div className="aspect-[16/10] overflow-hidden bg-[var(--surface-2)]">
        <img src={AGENT_ROLE_ASSETS.roles[role.id]} alt="" className="h-full w-full object-cover" />
      </div>
      <div className="space-y-4 p-4">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-[18px] font-semibold leading-6 text-[var(--text-1)]">{role.displayName}</h3>
            <Badge variant="outline" className="rounded-[6px]">{role.id}</Badge>
          </div>
          <p className="mt-1 text-[12px] font-medium text-[var(--text-3)]">{role.name} · {role.title}</p>
          <p className="mt-2 text-[13px] leading-6 text-[var(--text-2)]">{role.description}</p>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <DetailPill icon={role.concurrency.defaultReadOnly ? LockKeyhole : UnlockKeyhole} label={role.concurrency.defaultReadOnly ? '只读默认' : '可写默认'} />
          <DetailPill icon={Clock3} label={role.defaultBackground ? '后台运行' : '前台协作'} />
          <DetailPill icon={Boxes} label={role.defaultSkillName} className="col-span-2" />
        </div>

        <DetailSection title="输出类型">
          <TagList items={role.concurrency.outputTypes} />
        </DetailSection>

        <DetailSection title="推荐关键词">
          <TagList items={role.keywords.slice(0, 18)} />
        </DetailSection>

        <DetailSection title="可并行">
          <TagList items={parallelRoles.map((item) => item.displayName)} />
        </DetailSection>

        {conflictRoles.length > 0 && (
          <DetailSection title="冲突角色">
            <TagList items={conflictRoles.map((item) => item.displayName)} tone="warn" />
          </DetailSection>
        )}

        <DetailSection title="Prompt 摘要">
          <p className="max-h-[150px] overflow-y-auto rounded-[8px] border border-[var(--border)] bg-[var(--surface-2)] p-3 text-[12px] leading-5 text-[var(--text-2)]">
            {role.systemPrompt}
          </p>
        </DetailSection>
      </div>
    </aside>
  )
}

function DetailPill({
  icon: Icon,
  label,
  className,
}: {
  icon: LucideIcon
  label: string
  className?: string
}) {
  return (
    <div className={cn('flex h-9 items-center gap-2 rounded-[8px] border border-[var(--border)] px-3 text-[12px] font-medium text-[var(--text-2)]', className)}>
      <Icon size={14} className="text-[var(--brand)]" />
      <span className="truncate">{label}</span>
    </div>
  )
}

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h4 className="mb-2 text-[12px] font-semibold text-[var(--text-1)]">{title}</h4>
      {children}
    </section>
  )
}

function TagList({ items, tone = 'default' }: { items: string[]; tone?: 'default' | 'warn' }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <RoleBadge key={item} tone={tone}>{item}</RoleBadge>
      ))}
    </div>
  )
}

function RoleBadge({
  children,
  tone = 'default',
}: {
  children: React.ReactNode
  tone?: 'default' | 'warn'
}) {
  return (
    <span className={cn(
      'inline-flex h-6 items-center rounded-[6px] border px-2 text-[11px] font-medium',
      tone === 'warn'
        ? 'border-[#ffd6a6] bg-[#fff8ec] text-[#b46a00]'
        : 'border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-2)]'
    )}>
      {children}
    </span>
  )
}
