import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import {
  Activity,
  Bell,
  BookOpenText,
  Brain,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  Clock3,
  EllipsisVertical,
  FileText,
  Loader2,
  MessageCircle,
  Package,
  Pencil,
  PencilLine,
  Pause,
  Play,
  Check,
  ScrollText,
  SearchCheck,
  ShieldAlert,
  Sparkles,
  Tag,
  Trash2,
  X,
  type LucideIcon,
} from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  ShadcnSelect,
  ShadcnSelectContent,
  ShadcnSelectItem,
  ShadcnSelectTrigger,
  ShadcnSelectValue,
} from '@/components/ui/shadcn-select'
import { agentWorkspacesAtom, tabsAtom, activeTabIdAtom, welcomePromptSeedAtom } from '@/atoms'
import { automationJobsAtom, automationRunsAtom } from '@/atoms/automation-atoms'
import { THINKING_LEVEL_OPTIONS } from '@/components/settings/agent-settings-state'
import { useAutomationListeners } from '@/hooks/useAutomationListeners'
import { upsertWelcomeTab } from '@/components/app-shell/LeftSidebar'
import {
  createAutomationJob,
  deleteAutomationJob,
  listAutomationRuns,
  runAutomationJobNow,
  toggleAutomationJob,
  updateAutomationJob,
} from '@/lib/desktop-api/automation'
import { listChannels } from '@/lib/desktop-api/channel'
import type { AutomationJob, AutomationRun, AutomationSchedule, Channel } from '@lume/shared'

interface WorkspaceOption {
  id: string
  name: string
}

interface AutomationTemplate {
  id: string
  name: string
  description: string
  prompt: string
  schedule: AutomationSchedule
  icon: LucideIcon
}

interface CreateDraft {
  name: string
  prompt: string
  scheduleFrequency: string
  scheduleMinute: number
  scheduleDayOfWeek: number
  customCronExpr: string
  workspaceId: string
  defaultModel: string
  thinkingLevel: string
}

type AutomationListTab = 'manual' | 'system'

const FREQUENCY_OPTIONS: Array<{ id: string; label: string }> = [
  { id: 'hourly', label: '每小时' },
  { id: 'daily', label: '每天' },
  { id: 'weekday', label: '工作日' },
  { id: 'weekly', label: '每周' },
  { id: 'custom', label: '自定义' },
]

const TIME_OPTIONS = Array.from({ length: 96 }, (_, i) => {
  const hour = Math.floor(i / 4)
  const minute = (i % 4) * 15
  return { value: hour * 60 + minute, label: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}` }
})

const DOW_OPTIONS = [
  { value: 1, label: '一' },
  { value: 2, label: '二' },
  { value: 3, label: '三' },
  { value: 4, label: '四' },
  { value: 5, label: '五' },
  { value: 6, label: '六' },
  { value: 7, label: '日' },
]

const TEMPLATES: AutomationTemplate[] = [
  {
    id: 'daily-bug-scan',
    name: '每日缺陷扫描',
    description: '扫描最近提交，查找可能的 bug 并提出最小修复方案。',
    prompt: '扫描最近的 commit（自上次运行以来，或过去 24 小时内），查找可能的 bug 并提出最小修复方案。依据规则：\n- 只使用仓库中的具体证据（commit SHA、PR、文件路径、diff、失败的测试、CI 信号）。\n- 不要臆造 bug；如果证据不足，请说明并跳过。\n- 优先选择最小且安全的修复；避免重构和无关清理。',
    schedule: { type: 'cron', cronExpr: '0 9 * * *' },
    icon: SearchCheck,
  },
  {
    id: 'weekly-release-notes',
    name: '每周版本说明',
    description: '基于已合并 PR 起草每周发布说明。',
    prompt: '根据已合并的 PR 起草每周发布说明（如有链接请附上）。范围与依据：\n- 严格以该仓库当周历史记录为限；不要添加超出数据支持的额外部分。\n- 使用 PR 编号/标题；除非仓库中的 PR 描述、测试或指标支持，否则避免对影响作出结论。',
    schedule: { type: 'cron', cronExpr: '0 9 * * 1' },
    icon: BookOpenText,
  },
  {
    id: 'standup-summary',
    name: '站会摘要',
    description: '总结昨天的 git 活动，适合团队同步。',
    prompt: '为站会总结昨天的 git 活动。依据规则：\n- 陈述应锚定到 commit/PR/文件；不要臆测意图或未来工作。\n- 保持便于快速浏览，并适合团队同步。',
    schedule: { type: 'cron', cronExpr: '0 9 * * *' },
    icon: MessageCircle,
  },
  {
    id: 'nightly-ci-report',
    name: '夜间 CI 报告',
    description: '总结 CI 失败和不稳定测试，提出修复建议。',
    prompt: '总结上一个 CI 窗口中的 CI 失败和不稳定测试；提出首要修复建议。依据规则：\n- 尽可能引用具体作业、测试、错误信息或日志片段。\n- 避免过度自信地断言根因；区分”已观察到”与”疑似”。',
    schedule: { type: 'cron', cronExpr: '0 22 * * *' },
    icon: Bell,
  },
  {
    id: 'daily-classic-game',
    name: '每日经典游戏',
    description: '创建范围尽可能小的经典小游戏。',
    prompt: '创建一个范围尽可能小的经典小游戏。约束：\n- 除非必要，否则不要添加额外功能、样式系统、内容或新的依赖项。\n- 复用现有仓库的工具和模式。',
    schedule: { type: 'cron', cronExpr: '0 9 * * *' },
    icon: ClipboardList,
  },
  {
    id: 'skill-progression',
    name: '技能进阶图',
    description: '根据近期 PR 和评审建议下一步技能改进。',
    prompt: '根据近期 PR 和评审，建议下一步需要深入提升的技能。依据规则：\n- 每条建议都要锚定具体证据（PR 主题、评审意见、反复出现的问题）。\n- 避免空泛建议；每条建议都要可执行且具体。',
    schedule: { type: 'cron', cronExpr: '0 9 * * 1' },
    icon: Clock3,
  },
  {
    id: 'weekly-eng-summary',
    name: '每周工程摘要',
    description: '汇总本周 PR、发布、故障和评审成每周更新。',
    prompt: '将本周的 PR、发布、故障事件和评审汇总成一份每周更新。依据规则：\n- 不要虚构事件；如果数据缺失，请简要说明。\n- 在条件允许时，优先使用具体引用（PR 编号、故障事件 ID、发布说明、文件路径）。',
    schedule: { type: 'cron', cronExpr: '0 9 * * 5' },
    icon: FileText,
  },
  {
    id: 'perf-regression',
    name: '性能回归监测',
    description: '对比基准测试或追踪结果，标记性能回归。',
    prompt: '将最近的更改与基准测试或追踪结果进行比较，并尽早标记回归。依据规则：\n- 所有判断都应以可测量的信号（基准测试、追踪、耗时、火焰图）为依据。\n- 如果没有测量数据，请注明”未找到测量数据”，不要猜测。',
    schedule: { type: 'cron', cronExpr: '0 9 * * *' },
    icon: Activity,
  },
  {
    id: 'dep-sdk-drift',
    name: '依赖项和 SDK 漂移',
    description: '检测依赖项和 SDK 漂移，提出最小对齐方案。',
    prompt: '检测依赖项和 SDK 漂移，并提出最小对齐方案。依据规则：\n- 尽可能从仓库中引用当前版本和目标版本（锁文件、包清单文件）。\n- 不要猜测版本；如果目标不明确，请提出可选方案并标明为建议。',
    schedule: { type: 'cron', cronExpr: '0 9 * * 1' },
    icon: Package,
  },
  {
    id: 'issue-triage',
    name: '问题分类',
    description: '分诊新问题，建议负责人、优先级和标签。',
    prompt: '分诊新问题；建议负责人、优先级和标签。依据规则：\n- 根据问题内容 + 仓库上下文（CODEOWNERS、涉及区域、以往类似问题）给出建议。\n- 没有明确信号时不要猜测负责人；如不明确，请写”Owner: Unknown”，并改为建议一个团队。',
    schedule: { type: 'cron', cronExpr: '0 9 * * *' },
    icon: Tag,
  },
  {
    id: 'changelog-update',
    name: '更新变更日志',
    description: '用本周亮点和关键 PR 链接更新变更日志。',
    prompt: '用本周亮点和关键 PR 链接更新变更日志。约束：\n- 仅包含有仓库历史支持的条目。\n- 保持结构简洁，并与现有变更日志格式一致。',
    schedule: { type: 'cron', cronExpr: '0 17 * * 5' },
    icon: ScrollText,
  },
  {
    id: 'dep-security-scan',
    name: '依赖项扫描',
    description: '扫描过时依赖项，提出安全升级方案。',
    prompt: '扫描过时的依赖项；以最小改动提出安全升级方案。规则：\n- 优先采用最小可行的升级集合。\n- 明确标出破坏性变更风险和所需迁移。\n- 在未从仓库识别出当前版本前，不要提出升级建议。',
    schedule: { type: 'cron', cronExpr: '0 9 * * 1' },
    icon: ShieldAlert,
  },
]

export function AutomationManagementView() {
  useAutomationListeners()

  const workspaces = useAtomValue(agentWorkspacesAtom)
  const jobs = useAtomValue(automationJobsAtom)
  const runs = useAtomValue(automationRunsAtom)
  const setJobs = useSetAtom(automationJobsAtom)
  const setTabs = useSetAtom(tabsAtom)
  const setActiveTabId = useSetAtom(activeTabIdAtom)
  const setWelcomePromptSeed = useSetAtom(welcomePromptSeedAtom)
  const [menuOpen, setMenuOpen] = useState(false)
  const [templatesOpen, setTemplatesOpen] = useState(false)
  const [dialogMode, setDialogMode] = useState<'manual' | 'edit' | null>(null)
  const [editingJob, setEditingJob] = useState<AutomationJob | null>(null)
  const [templateDraft, setTemplateDraft] = useState<CreateDraft | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null)
  const [selectedRuns, setSelectedRuns] = useState<AutomationRun[] | null>(null)
  const [listTab, setListTab] = useState<AutomationListTab>('manual')

  const selectedJob = useMemo(() => jobs.find((j) => j.id === selectedJobId) ?? null, [jobs, selectedJobId])
  const selectedJobRuns = selectedRuns ?? (selectedJobId ? runs.filter((r) => r.jobId === selectedJobId) : [])
  const manualJobs = useMemo(() => jobs.filter((job) => !isSystemAutomationJob(job)), [jobs])
  const systemJobs = useMemo(() => jobs.filter(isSystemAutomationJob), [jobs])
  const visibleJobs = listTab === 'manual' ? manualJobs : systemJobs

  const workspaceOptions = useMemo<WorkspaceOption[]>(() => (
    workspaces.map((workspace) => ({ id: workspace.id, name: workspace.name }))
  ), [workspaces])

  const defaultWorkspaceId = workspaceOptions[0]?.id ?? ''

  useEffect(() => {
    if (!selectedJobId) {
      setSelectedRuns(null)
      return
    }
    let cancelled = false
    setSelectedRuns(null)
    listAutomationRuns({ jobId: selectedJobId, limit: 50 })
      .then((items) => {
        if (!cancelled) setSelectedRuns(items)
      })
      .catch((error) => console.error('[AutomationManagementView] 加载运行历史失败:', error))
    return () => {
      cancelled = true
    }
  }, [selectedJobId, runs])

  const createFromTemplate = useCallback((template: AutomationTemplate) => {
    const { frequency, minuteOfDay, dayOfWeek } = frequencyForSchedule(template.schedule)
    setTemplateDraft({
      name: template.name,
      prompt: template.prompt,
      scheduleFrequency: frequency,
      scheduleMinute: minuteOfDay,
      scheduleDayOfWeek: dayOfWeek,
      customCronExpr: '',
      workspaceId: defaultWorkspaceId,
      defaultModel: '',
      thinkingLevel: 'off',
    })
    setTemplatesOpen(false)
    setDialogMode('manual')
  }, [defaultWorkspaceId])

  const openEditDialog = useCallback((job: AutomationJob) => {
    setEditingJob(job)
    setDialogMode('edit')
  }, [])

  const openChatCreate = useCallback(() => {
    setWelcomePromptSeed('我想设置一个自动化。请先简要说明 Lume 中的自动化如何运作，再问我几个问题，以了解我希望 Lume 做什么，以及它应在何时运行。')
    setTabs((prev) => upsertWelcomeTab(prev, defaultWorkspaceId || null))
    setActiveTabId('__welcome__')
    setMenuOpen(false)
  }, [defaultWorkspaceId, setTabs, setActiveTabId, setWelcomePromptSeed])

  const saveDraft = useCallback(async (draft: CreateDraft) => {
    const name = draft.name.trim()
    const prompt = draft.prompt.trim()
    if (!name || !prompt) return

    setSubmitting(true)
    try {
      if (dialogMode === 'edit' && editingJob) {
        const updated = await updateAutomationJob({
          id: editingJob.id,
          name,
          description: summarizePrompt(prompt),
          prompt,
          workspaceId: draft.workspaceId || undefined,
          schedule: scheduleForDraft(draft.scheduleFrequency, draft.scheduleMinute, draft.scheduleDayOfWeek, draft.customCronExpr),
          defaultModel: draft.defaultModel || undefined,
          thinkingLevel: draft.thinkingLevel === 'off' ? undefined : draft.thinkingLevel,
        })
        setJobs((previous) => upsertAutomationJob(previous, updated))
      } else {
        const created = await createAutomationJob({
          name,
          description: summarizePrompt(prompt),
          prompt,
          workspaceId: draft.workspaceId || undefined,
          schedule: scheduleForDraft(draft.scheduleFrequency, draft.scheduleMinute, draft.scheduleDayOfWeek, draft.customCronExpr),
          triggerModes: ['schedule'],
          defaultModel: draft.defaultModel || undefined,
          thinkingLevel: draft.thinkingLevel === 'off' ? undefined : draft.thinkingLevel,
          source: 'manual',
        })
        setJobs((previous) => upsertAutomationJob(previous, created))
      }
      setDialogMode(null)
      setEditingJob(null)
      setTemplateDraft(null)
    } catch (error) {
      console.error('[AutomationManagementView] 保存自动化失败:', error)
    } finally {
      setSubmitting(false)
    }
  }, [dialogMode, editingJob, setJobs])

  return (
    <div className="flex min-h-0 flex-1 bg-[var(--background)]">
      <ScrollArea className="min-h-0 flex-1">
        <main className="relative mx-auto flex min-h-[calc(100vh-56px)] w-full max-w-[1120px] flex-col px-8 py-5">
          {selectedJob ? (
            <AutomationJobDetail
              job={selectedJob}
              runs={selectedJobRuns}
              onBack={() => setSelectedJobId(null)}
              onToggle={async () => {
                const updated = await toggleAutomationJob(selectedJob.id)
                setJobs((prev) => upsertAutomationJob(prev, updated))
              }}
              onDelete={async () => {
                await deleteAutomationJob(selectedJob.id)
                setJobs((prev) => prev.filter((j) => j.id !== selectedJob.id))
                setSelectedJobId(null)
              }}
              onRun={async () => {
                await runAutomationJobNow(selectedJob.id)
              }}
              onSave={async (draft) => {
                const updated = await updateAutomationJob({
                  id: selectedJob.id,
                  name: draft.name,
                  description: summarizePrompt(draft.prompt),
                  prompt: draft.prompt,
                  schedule: scheduleForDraft(draft.scheduleFrequency, draft.scheduleMinute, draft.scheduleDayOfWeek, draft.customCronExpr),
                  defaultModel: draft.defaultModel || undefined,
                  thinkingLevel: draft.thinkingLevel === 'off' ? undefined : draft.thinkingLevel,
                })
                setJobs((prev) => upsertAutomationJob(prev, updated))
              }}
            />
          ) : (
            <>
              <header className="flex items-start justify-between gap-6">
                <div>
                  <h1 className="text-[22px] font-semibold leading-7 text-[var(--text-1)]">自动化</h1>
                  <p className="mt-1 text-[13px] leading-5 text-[var(--text-2)]">
                    按计划或按需运行聊天。<button type="button" className="text-[var(--brand)]">了解更多</button>
                  </p>
                </div>

                <div className="relative flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setTemplatesOpen(true)}
                    className="h-8 rounded-[8px] border border-[var(--border)] bg-[var(--surface-1)] px-3 text-[13px] font-medium text-[var(--text-1)] shadow-[0_1px_2px_rgba(31,35,70,0.04)] transition-colors hover:bg-[var(--surface-2)]"
                  >
                    查看模板
                  </button>
                  <button
                    type="button"
                    onClick={() => setMenuOpen((value) => !value)}
                    className="flex h-8 items-center gap-1.5 rounded-[8px] bg-[var(--text-1)] px-3 text-[13px] font-semibold text-white transition-colors hover:opacity-90"
                  >
                    手动创建
                    <ChevronDown size={14} />
                  </button>

                  {menuOpen && (
                    <div className="absolute right-0 top-10 z-20 w-[168px] rounded-[10px] border border-[var(--border)] bg-[var(--surface-1)] p-1.5 shadow-[0_18px_50px_rgba(28,32,58,0.18)]">
                      <MenuButton
                        icon={MessageCircle}
                        label="通过聊天创建"
                        onClick={openChatCreate}
                      />
                      <MenuButton
                        icon={PencilLine}
                        label="手动创建"
                        onClick={() => {
                          setDialogMode('manual')
                          setMenuOpen(false)
                        }}
                      />
                    </div>
                  )}
                </div>
              </header>

              {jobs.length === 0 ? (
                <EmptyAutomationState
                  onCreateTemplate={createFromTemplate}
                />
              ) : (
                <>
                  <AutomationSourceTabs
                    value={listTab}
                    manualCount={manualJobs.length}
                    systemCount={systemJobs.length}
                    onChange={setListTab}
                  />
                  <AutomationList jobs={visibleJobs} runs={runs} onEdit={openEditDialog} onSelect={(id) => setSelectedJobId(id)} />
                </>
              )}
            </>
          )}
        </main>
      </ScrollArea>

      <CreateAutomationDialog
        key={`${dialogMode}-${editingJob?.id ?? 'new'}-${templateDraft?.name ?? ''}`}
        mode={dialogMode}
        editingJob={editingJob}
        templateDraft={templateDraft}
        workspaceOptions={workspaceOptions}
        submitting={submitting}
        onCancel={() => { setDialogMode(null); setEditingJob(null); setTemplateDraft(null) }}
        onSubmit={saveDraft}
        onOpenTemplates={() => { setDialogMode(null); setTemplatesOpen(true) }}
      />
      <AutomationTemplateDialog
        open={templatesOpen}
        onClose={() => setTemplatesOpen(false)}
        onManualSetup={() => {
          setTemplatesOpen(false)
          setDialogMode('manual')
        }}
        onCreateTemplate={createFromTemplate}
      />
    </div>
  )
}

function EmptyAutomationState({
  onCreateTemplate,
}: {
  onCreateTemplate: (template: AutomationTemplate) => void
}) {
  return (
    <section className="flex flex-1 flex-col items-center justify-center pb-16 text-center">
      <div className="flex size-[84px] items-center justify-center rounded-[20px] text-[var(--text-1)]">
        <ClipboardList size={58} strokeWidth={1.7} />
      </div>
      <h2 className="mt-5 text-[14px] font-semibold text-[var(--text-1)]">创建首个自动化</h2>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        {TEMPLATES.slice(0, 3).map((template) => {
          const Icon = template.icon
          return (
            <button
              key={template.id}
              type="button"
              onClick={() => onCreateTemplate(template)}
              className="flex h-9 items-center gap-2 rounded-[8px] border border-[var(--border)] bg-[var(--surface-1)] px-3 text-[13px] font-semibold text-[var(--text-1)] shadow-[0_1px_2px_rgba(31,35,70,0.03)] transition-colors hover:bg-[var(--surface-2)]"
            >
              <Icon size={17} />
              {template.name}
            </button>
          )
        })}
      </div>
    </section>
  )
}

function AutomationSourceTabs({
  value,
  manualCount,
  systemCount,
  onChange,
}: {
  value: AutomationListTab
  manualCount: number
  systemCount: number
  onChange: (value: AutomationListTab) => void
}) {
  return (
    <div className="mt-8 inline-flex w-fit rounded-[8px] border border-[var(--border)] bg-[var(--surface-1)] p-0.5">
      <AutomationSourceTabButton active={value === 'manual'} label="用户创建" count={manualCount} onClick={() => onChange('manual')} />
      <AutomationSourceTabButton active={value === 'system'} label="系统日程" count={systemCount} onClick={() => onChange('system')} />
    </div>
  )
}

function AutomationSourceTabButton({
  active,
  label,
  count,
  onClick,
}: {
  active: boolean
  label: string
  count: number
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`h-7 rounded-[6px] px-3 text-[12px] font-medium transition-colors ${
        active
          ? 'bg-[var(--text-1)] text-white'
          : 'text-[var(--text-2)] hover:bg-[var(--surface-2)] hover:text-[var(--text-1)]'
      }`}
    >
      {label} {count}
    </button>
  )
}

function AutomationList({ jobs, runs, onEdit, onSelect }: { jobs: AutomationJob[]; runs: AutomationRun[]; onEdit: (job: AutomationJob) => void; onSelect: (id: string) => void }) {
  const setJobs = useSetAtom(automationJobsAtom)
  const [completedOpen, setCompletedOpen] = useState(false)
  const activeJobs = jobs.filter((job) => !isCompletedAutomationJob(job))
  const completedJobs = jobs.filter(isCompletedAutomationJob)

  return (
    <section className="mt-5 grid max-w-[760px] gap-5">
      {jobs.length === 0 ? (
        <p className="py-10 text-center text-[13px] text-[var(--text-3)]">暂无任务</p>
      ) : (
        <>
          <AutomationJobGroup
            jobs={activeJobs}
            runs={runs}
            title="进行中"
            emptyLabel="暂无进行中的任务"
            onEdit={onEdit}
            onSelect={onSelect}
            setJobs={setJobs}
          />
          {completedJobs.length > 0 && (
            <div>
              <button
                type="button"
                onClick={() => setCompletedOpen((value) => !value)}
                className="mb-2 flex h-7 items-center gap-1.5 text-[12px] font-medium text-[var(--text-3)] transition-colors hover:text-[var(--text-1)]"
              >
                {completedOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                已完成 {completedJobs.length}
              </button>
              {completedOpen && (
                <AutomationJobGroup
                  jobs={completedJobs}
                  runs={runs}
                  title=""
                  emptyLabel=""
                  onEdit={onEdit}
                  onSelect={onSelect}
                  setJobs={setJobs}
                />
              )}
            </div>
          )}
        </>
      )}
    </section>
  )
}

function AutomationJobGroup({
  jobs,
  runs,
  title,
  emptyLabel,
  onEdit,
  onSelect,
  setJobs,
}: {
  jobs: AutomationJob[]
  runs: AutomationRun[]
  title: string
  emptyLabel: string
  onEdit: (job: AutomationJob) => void
  onSelect: (id: string) => void
  setJobs: (update: (jobs: AutomationJob[]) => AutomationJob[]) => void
}) {
  return (
    <div>
      {title && <h2 className="mb-2 text-[12px] font-medium text-[var(--text-3)]">{title} {jobs.length}</h2>}
      {jobs.length === 0 ? (
        emptyLabel ? <p className="py-4 text-[13px] text-[var(--text-3)]">{emptyLabel}</p> : null
      ) : (
        <div className="grid gap-2.5">
          {jobs.map((job) => {
            const run = runs.find((item) => item.jobId === job.id)
            return (
              <AutomationJobRow
                key={job.id}
                job={job}
                run={run}
                onEdit={() => onEdit(job)}
                onSelect={() => onSelect(job.id)}
                onToggle={async () => {
                  const updated = await toggleAutomationJob(job.id)
                  setJobs((prev) => upsertAutomationJob(prev, updated))
                }}
                onDelete={async () => {
                  await deleteAutomationJob(job.id)
                  setJobs((prev) => prev.filter((j) => j.id !== job.id))
                }}
                onRun={async () => {
                  await runAutomationJobNow(job.id)
                }}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

function AutomationJobRow({
  job,
  run,
  onEdit,
  onToggle,
  onDelete,
  onRun,
  onSelect,
}: {
  job: AutomationJob
  run: AutomationRun | undefined
  onEdit: () => void
  onToggle: () => Promise<void>
  onDelete: () => Promise<void>
  onRun: () => Promise<void>
  onSelect: () => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const statusLabel = automationJobStatusLabel(job)
  const moduleLabel = automationModuleLabel(job)

  return (
    <article
      onClick={onSelect}
      className="group relative grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-4 rounded-[8px] border border-[var(--border)] bg-[var(--surface-1)] px-3.5 py-3 shadow-[0_1px_2px_rgba(31,35,70,0.03)] transition-colors hover:bg-[var(--surface-2)]"
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h2 className="truncate text-[13px] font-semibold text-[var(--text-1)]">{job.name}</h2>
          <AutomationBadge label={automationSourceLabel(job)} />
          {moduleLabel && <AutomationBadge label={`模块：${moduleLabel}`} />}
          {statusLabel && <AutomationBadge label={statusLabel} />}
        </div>
        <p className="mt-1 truncate text-[13px] text-[var(--text-2)]">{job.description ?? summarizePrompt(job.prompt)}</p>
      </div>

      {/* 默认：显示定时时间 */}
      <div className="text-right text-[12px] leading-5 text-[var(--text-3)] group-hover:hidden">
        <div className="flex items-center justify-end gap-1.5 text-[var(--text-2)]">
          <Clock3 size={13} />
          {scheduleLabel(job.schedule)}
        </div>
        <div>{run ? `上次 ${formatShortTime(run.startedAt)}` : job.nextRunAt ? `下次 ${formatShortTime(job.nextRunAt)}` : '未运行'}</div>
      </div>

      {/* Hover：显示操作按钮 */}
      <div className="hidden items-center gap-0.5 group-hover:flex" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          onClick={onRun}
          title="立即运行"
          className="flex size-7 items-center justify-center rounded-[6px] text-[var(--text-2)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-1)]"
        >
          <Play size={15} />
        </button>
        <button
          type="button"
          onClick={onEdit}
          title="编辑"
          className="flex size-7 items-center justify-center rounded-[6px] text-[var(--text-2)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-1)]"
        >
          <Pencil size={15} />
        </button>
        <div className="relative">
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            className="flex size-7 items-center justify-center rounded-[6px] text-[var(--text-2)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-1)]"
          >
            <EllipsisVertical size={15} />
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-9 z-20 w-[120px] rounded-[8px] border border-[var(--border)] bg-[var(--surface-1)] p-1 shadow-[0_8px_30px_rgba(28,32,58,0.16)]">
              <button
                type="button"
                onClick={() => { setMenuOpen(false); onToggle() }}
                className="flex h-8 w-full items-center gap-2 rounded-[6px] px-2.5 text-left text-[13px] text-[var(--text-1)] hover:bg-[var(--surface-2)]"
              >
                暂停
              </button>
              <button
                type="button"
                onClick={() => { setMenuOpen(false); onDelete() }}
                className="flex h-8 w-full items-center gap-2 rounded-[6px] px-2.5 text-left text-[13px] text-red-500 hover:bg-[var(--surface-2)]"
              >
                删除
              </button>
            </div>
          )}
        </div>
      </div>
    </article>
  )
}

function AutomationBadge({ label }: { label: string }) {
  return (
    <span className="shrink-0 rounded-full bg-[var(--surface-2)] px-2 py-0.5 text-[11px] font-medium text-[var(--text-3)]">
      {label}
    </span>
  )
}

function AutomationJobDetail({
  job,
  runs,
  onBack,
  onToggle,
  onDelete,
  onRun,
  onSave,
}: {
  job: AutomationJob
  runs: AutomationRun[]
  onBack: () => void
  onToggle: () => Promise<void>
  onDelete: () => Promise<void>
  onRun: () => Promise<void>
  onSave: (draft: CreateDraft) => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [channels, setChannels] = useState<Channel[]>([])
  const [scheduleOpen, setScheduleOpen] = useState(false)
  const statusLabel = automationJobStatusLabel(job) ?? (job.enabled ? '活跃' : '已停用')
  const moduleLabel = automationModuleLabel(job)

  const { frequency, minuteOfDay, dayOfWeek, customCron } = useMemo(() => frequencyForSchedule(job.schedule), [job.schedule])
  const thinkingLabel = THINKING_LEVEL_OPTIONS.find((t) => t.value === (job.thinkingLevel ?? 'off'))?.label ?? '关闭'

  const [draft, setDraft] = useState<CreateDraft>(() => ({
    name: job.name,
    prompt: job.prompt,
    scheduleFrequency: frequency,
    scheduleMinute: minuteOfDay,
    scheduleDayOfWeek: dayOfWeek,
    customCronExpr: customCron,
    workspaceId: job.workspaceId ?? '',
    defaultModel: job.defaultModel ?? '',
    thinkingLevel: job.thinkingLevel ?? 'off',
  }))

  useEffect(() => {
    if (editing) {
      setDraft({
        name: job.name,
        prompt: job.prompt,
        scheduleFrequency: frequency,
        scheduleMinute: minuteOfDay,
        scheduleDayOfWeek: dayOfWeek,
        customCronExpr: customCron,
        workspaceId: job.workspaceId ?? '',
        defaultModel: job.defaultModel ?? '',
        thinkingLevel: job.thinkingLevel ?? 'off',
      })
    }
  }, [editing, job, frequency, minuteOfDay, dayOfWeek, customCron])

  useEffect(() => {
    listChannels()
      .then((items) => setChannels(items.filter((ch) => ch.models.length > 0)))
      .catch(console.error)
  }, [])

  const modelOptions = useMemo(() => channels.flatMap((ch) =>
    ch.models.filter((m) => m.enabled).map((m) => ({ value: `${ch.provider}/${m.id}`, label: m.name || m.id }))
  ), [channels])

  const handleSave = useCallback(async () => {
    setSaving(true)
    try {
      await onSave(draft)
      setEditing(false)
    } finally {
      setSaving(false)
    }
  }, [draft, onSave])

  const handleCancel = useCallback(() => {
    setDraft({
      name: job.name,
      prompt: job.prompt,
      scheduleFrequency: frequency,
      scheduleMinute: minuteOfDay,
      scheduleDayOfWeek: dayOfWeek,
      customCronExpr: customCron,
      workspaceId: job.workspaceId ?? '',
      defaultModel: job.defaultModel ?? '',
      thinkingLevel: job.thinkingLevel ?? 'off',
    })
    setEditing(false)
  }, [job, frequency, minuteOfDay, dayOfWeek, customCron])

  return (
    <>
      {/* 面包屑 */}
      <nav className="flex items-center gap-1.5 text-[14px] text-[var(--text-3)]">
        <button type="button" onClick={onBack} className="transition-colors hover:text-[var(--text-1)]">主页</button>
        <ChevronRight size={14} />
        <button type="button" onClick={onBack} className="transition-colors hover:text-[var(--text-1)]">工作流</button>
        <ChevronRight size={14} />
        <span className="text-[var(--text-1)]">{editing ? draft.name : job.name}</span>
      </nav>

      {/* 标题 + 操作按钮 */}
      <div className="mt-6 flex items-center justify-between">
        {editing ? (
          <input
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            className="min-w-0 flex-1 bg-transparent text-[28px] font-semibold leading-9 text-[var(--text-1)] outline-none"
          />
        ) : (
          <h1 className="text-[28px] font-semibold leading-9 text-[var(--text-1)]">{job.name}</h1>
        )}
        <div className="flex items-center gap-3">
          {editing ? (
            <>
              <button
                type="button"
                onClick={handleCancel}
                className="h-8 rounded-[6px] px-3 text-[14px] text-[var(--text-2)] transition-colors hover:bg-[var(--surface-2)]"
              >
                取消
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={saving || !draft.name.trim() || !draft.prompt.trim()}
                className="flex h-8 items-center gap-1.5 rounded-[6px] bg-[var(--text-1)] px-4 text-[14px] font-semibold text-white transition-colors hover:opacity-90 disabled:opacity-50"
              >
                {saving && <Loader2 size={14} className="animate-spin" />}
                保存
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setEditing(true)}
                title="编辑"
                className="flex size-8 items-center justify-center rounded-[6px] text-[var(--text-3)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-1)]"
              >
                <Pencil size={18} />
              </button>
              <button
                type="button"
                onClick={onToggle}
                title={job.enabled ? '暂停' : '启用'}
                className="flex size-8 items-center justify-center rounded-[6px] text-[var(--text-3)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-1)]"
              >
                <Pause size={18} />
              </button>
              <button
                type="button"
                onClick={onDelete}
                title="删除"
                className="flex size-8 items-center justify-center rounded-[6px] text-[var(--text-3)] transition-colors hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950"
              >
                <Trash2 size={18} />
              </button>
              <button
                type="button"
                onClick={onRun}
                className="flex h-8 items-center gap-1.5 rounded-[6px] bg-[var(--text-1)] px-4 text-[14px] font-semibold text-white transition-colors hover:opacity-90"
              >
                <Play size={14} />
                立即运行
              </button>
            </>
          )}
        </div>
      </div>

      {/* 两栏布局 */}
      <div className="mt-6 flex gap-8">
        {/* 左侧：提示词 */}
        <div className="min-w-0 flex-1">
          {editing ? (
            <textarea
              value={draft.prompt}
              onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
              className="min-h-[200px] w-full resize-none bg-transparent text-[16px] leading-6 text-[var(--text-2)] outline-none"
            />
          ) : (
            <p className="whitespace-pre-wrap text-[16px] leading-6 text-[var(--text-2)]">{job.prompt}</p>
          )}
        </div>

        {/* 右侧边栏 */}
        <div className="flex w-[320px] shrink-0 flex-col gap-6">
          {/* 状态 */}
          <div>
            <h3 className="mb-3 text-[14px] font-semibold text-[var(--text-3)]">状态</h3>
            <div className="flex items-center gap-2">
              <span className={`size-2 rounded-full ${job.enabled ? 'bg-emerald-500' : 'bg-[var(--text-3)]'}`} />
              <span className={`text-[14px] ${job.enabled ? 'text-emerald-600 dark:text-emerald-400' : 'text-[var(--text-1)]'}`}>{statusLabel}</span>
            </div>
            <DetailRow label="来源" value={automationSourceLabel(job)} />
            {moduleLabel && <DetailRow label="模块" value={moduleLabel} />}
            {job.nextRunAt ? (
              <DetailRow label="下次运行" value={formatShortTime(job.nextRunAt)} />
            ) : null}
            {job.lastRunAt ? (
              <DetailRow label="上次运行时间" value={formatShortTime(job.lastRunAt)} />
            ) : null}
          </div>

          {/* 详情 */}
          <div>
            <h3 className="mb-3 text-[14px] font-semibold text-[var(--text-3)]">详情</h3>
            {editing ? (
              <>
                {/* 调度选择 */}
                <div className="relative pt-3">
                  <div className="flex items-center justify-between">
                    <span className="text-[14px] text-[var(--text-2)]">重复次数</span>
                    <button
                      type="button"
                      onClick={() => setScheduleOpen((v) => !v)}
                      className="flex items-center gap-1 text-[14px] text-[var(--text-3)] transition-colors hover:text-[var(--text-1)]"
                    >
                      {scheduleLabelForDraft(draft.scheduleFrequency, draft.scheduleMinute, draft.scheduleDayOfWeek, draft.customCronExpr)}
                      <ChevronDown size={14} />
                    </button>
                  </div>
                  {scheduleOpen && (
                    <SchedulePickerPopup
                      frequency={draft.scheduleFrequency}
                      minuteOfDay={draft.scheduleMinute}
                      dayOfWeek={draft.scheduleDayOfWeek}
                      customCron={draft.customCronExpr}
                      onFrequencyChange={(f) => setDraft({ ...draft, scheduleFrequency: f })}
                      onMinuteChange={(m) => { setDraft({ ...draft, scheduleMinute: m }); setScheduleOpen(false) }}
                      onDayOfWeekChange={(d) => setDraft({ ...draft, scheduleDayOfWeek: d })}
                      onCustomCronChange={(c) => setDraft({ ...draft, customCronExpr: c })}
                      onClose={() => setScheduleOpen(false)}
                    />
                  )}
                </div>
                {/* 模型选择 */}
                <div className="flex items-center justify-between pt-3">
                  <span className="text-[14px] text-[var(--text-2)]">模型</span>
                  <ShadcnSelect
                    value={draft.defaultModel || '__none__'}
                    onValueChange={(v) => setDraft({ ...draft, defaultModel: v === '__none__' ? '' : v })}
                  >
                    <ShadcnSelectTrigger className="h-7 w-auto gap-1 rounded-[6px] border-[var(--border)] bg-[var(--surface-1)] px-2 text-[14px] text-[var(--text-3)] shadow-none hover:bg-[var(--surface-2)] [&_svg:last-child]:size-3 [&_svg:last-child]:text-[var(--text-3)]">
                      <ShadcnSelectValue placeholder="默认模型" />
                    </ShadcnSelectTrigger>
                    <ShadcnSelectContent className="z-[100]">
                      <ShadcnSelectItem value="__none__">默认模型</ShadcnSelectItem>
                      {modelOptions.map((opt) => (
                        <ShadcnSelectItem key={opt.value} value={opt.value}>{opt.label}</ShadcnSelectItem>
                      ))}
                    </ShadcnSelectContent>
                  </ShadcnSelect>
                </div>
                {/* 推理强度 */}
                <div className="flex items-center justify-between pt-3">
                  <span className="text-[14px] text-[var(--text-2)]">推理</span>
                  <ShadcnSelect
                    value={draft.thinkingLevel}
                    onValueChange={(v) => setDraft({ ...draft, thinkingLevel: v })}
                  >
                    <ShadcnSelectTrigger className="h-7 w-auto gap-1 rounded-[6px] border-[var(--border)] bg-[var(--surface-1)] px-2 text-[14px] text-[var(--text-3)] shadow-none hover:bg-[var(--surface-2)] [&_svg:last-child]:size-3 [&_svg:last-child]:text-[var(--text-3)]">
                      <ShadcnSelectValue />
                    </ShadcnSelectTrigger>
                    <ShadcnSelectContent className="z-[100]">
                      {THINKING_LEVEL_OPTIONS.map((opt) => (
                        <ShadcnSelectItem key={opt.value} value={opt.value}>{opt.label}</ShadcnSelectItem>
                      ))}
                    </ShadcnSelectContent>
                  </ShadcnSelect>
                </div>
              </>
            ) : (
              <>
                <DetailRow label="重复次数" value={scheduleLabel(job.schedule)} />
                {job.defaultModel && <DetailRow label="模型" value={job.defaultModel} />}
                <DetailRow label="推理" value={thinkingLabel} />
              </>
            )}
          </div>

          {/* 运行历史 */}
          <div>
            <h3 className="mb-3 text-[14px] font-semibold text-[var(--text-3)]">运行历史记录</h3>
            {runs.length > 0 ? (
              <div className="flex flex-col gap-3">
                {runs.slice(0, 10).map((run) => (
                  <div key={run.id} className="flex items-center gap-2.5">
                    <span className={`size-2 shrink-0 rounded-full ${
                      run.status === 'success' ? 'bg-emerald-500'
                        : run.status === 'failed' ? 'bg-red-500'
                          : 'bg-amber-500'
                    }`} />
                    <span className="min-w-0 flex-1 truncate text-[14px] text-[var(--text-1)]">{run.jobName}</span>
                    <span className="shrink-0 text-[14px] text-[var(--text-3)]">{formatDuration(run.startedAt, run.finishedAt)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-[14px] text-[var(--text-3)]">暂无运行记录</p>
            )}
          </div>
        </div>
      </div>
    </>
  )
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between pt-3">
      <span className="text-[14px] text-[var(--text-2)]">{label}</span>
      <span className="text-[14px] text-[var(--text-3)]">{value}</span>
    </div>
  )
}

function formatDuration(startMs: number, endMs: number): string {
  const seconds = Math.round((endMs - startMs) / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainSeconds = seconds % 60
  return remainSeconds ? `${minutes}m ${remainSeconds}s` : `${minutes}m`
}

function MenuButton({
  icon: Icon,
  label,
  onClick,
}: {
  icon: LucideIcon
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-9 w-full items-center gap-2 rounded-[8px] px-2.5 text-left text-[13px] font-medium text-[var(--text-1)] transition-colors hover:bg-[var(--surface-2)]"
    >
      <Icon size={16} />
      {label}
    </button>
  )
}

function AutomationTemplateDialog({
  open,
  onClose,
  onManualSetup,
  onCreateTemplate,
}: {
  open: boolean
  onClose: () => void
  onManualSetup: () => void
  onCreateTemplate: (template: AutomationTemplate) => void
}) {
  if (!open) return null

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/16 px-5 py-6" onClick={onClose}>
      <section
        className="flex max-h-[min(760px,calc(100vh-48px))] w-full max-w-[860px] flex-col rounded-[18px] border border-[var(--border)] bg-[var(--surface-1)] px-7 py-6 shadow-[0_22px_70px_rgba(24,28,48,0.20)]"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between gap-4">
          <h2 className="text-[22px] font-semibold leading-7 text-[var(--text-1)]">自动化模板</h2>
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={onManualSetup}
              className="h-9 rounded-[8px] border border-[var(--border)] bg-[var(--surface-1)] px-4 text-[13px] font-semibold text-[var(--text-1)] transition-colors hover:bg-[var(--surface-2)]"
            >
              手动设置
            </button>
            <button
              type="button"
              onClick={onClose}
              className="flex size-8 items-center justify-center rounded-[8px] text-[var(--text-2)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-1)]"
            >
              <X size={18} />
            </button>
          </div>
        </header>

        <div className="mt-7 grid min-h-0 grid-cols-2 gap-5 overflow-y-auto pr-1">
          {TEMPLATES.map((template) => (
            <AutomationTemplateCard
              key={template.id}
              template={template}
              onCreate={() => onCreateTemplate(template)}
            />
          ))}
        </div>
      </section>
    </div>
  )
}

function AutomationTemplateCard({
  template,
  onCreate,
}: {
  template: AutomationTemplate
  onCreate: () => void
}) {
  const Icon = template.icon

  return (
    <button
      type="button"
      onClick={onCreate}
      title={template.name}
      className="flex flex-col rounded-[12px] border border-[var(--border)] bg-[var(--surface-1)] px-4 py-3.5 text-left transition-colors hover:bg-[var(--surface-2)]"
    >
      <div className="mb-3 flex h-5 items-center text-[var(--brand)]">
        <Icon size={18} strokeWidth={2} />
      </div>
      <h3 className="text-[13px] text-[var(--text-1)]">{template.name}</h3>
      <p className="mt-1 text-[13px] leading-5 text-[var(--text-2)]">{template.description}</p>
    </button>
  )
}

function CreateAutomationDialog({
  mode,
  editingJob,
  templateDraft,
  workspaceOptions,
  submitting,
  onCancel,
  onSubmit,
  onOpenTemplates,
}: {
  mode: 'manual' | 'edit' | null
  editingJob: AutomationJob | null
  templateDraft: CreateDraft | null
  workspaceOptions: WorkspaceOption[]
  submitting: boolean
  onCancel: () => void
  onSubmit: (draft: CreateDraft) => void
  onOpenTemplates: () => void
}) {
  const [channels, setChannels] = useState<Channel[]>([])
  const [draft, setDraft] = useState<CreateDraft>(() => {
    if (editingJob) {
      const { frequency, minuteOfDay, dayOfWeek, customCron } = frequencyForSchedule(editingJob.schedule)
      return {
        name: editingJob.name,
        prompt: editingJob.prompt,
        scheduleFrequency: frequency,
        scheduleMinute: minuteOfDay,
        scheduleDayOfWeek: dayOfWeek,
        customCronExpr: customCron,
        workspaceId: editingJob.workspaceId ?? '',
        defaultModel: editingJob.defaultModel ?? '',
        thinkingLevel: editingJob.thinkingLevel ?? 'off',
      }
    }
    if (templateDraft) return templateDraft
    return createEmptyDraft(workspaceOptions[0]?.id ?? '')
  })

  const [scheduleOpen, setScheduleOpen] = useState(false)

  useEffect(() => {
    listChannels()
      .then((items) => setChannels(items.filter((ch) => ch.models.length > 0)))
      .catch(console.error)
  }, [])

  if (!mode) return null

  const isEdit = mode === 'edit'

  const modelOptions = channels.flatMap((ch) =>
    ch.models
      .filter((m) => m.enabled)
      .map((m) => ({ value: `${ch.provider}/${m.id}`, label: m.name || m.id, provider: ch.provider }))
  )

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/24" onClick={onCancel}>
      <div
        className="flex w-full max-w-[640px] flex-col rounded-[14px] border border-[var(--border)] bg-[var(--surface-1)] shadow-[0_24px_70px_rgba(27,32,58,0.22)]"
        onClick={(event) => event.stopPropagation()}
      >
        {/* 顶部：标题输入 + 操作按钮 */}
        <div className="flex items-center justify-between border-b border-[var(--border)] px-5 py-3">
          <input
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            placeholder="自动化功能标题"
            className="min-w-0 flex-1 bg-transparent text-[16px] font-semibold text-[var(--text-1)] outline-none placeholder:text-[var(--text-3)]"
          />
          <div className="flex items-center gap-2">
            {!isEdit && (
              <button
                type="button"
                onClick={onOpenTemplates}
                className="h-7 rounded-[6px] border border-[var(--border)] bg-[var(--surface-1)] px-2.5 text-[12px] font-medium text-[var(--text-2)] transition-colors hover:bg-[var(--surface-2)]"
              >
                使用模板
              </button>
            )}
            <button
              type="button"
              onClick={onCancel}
              className="flex size-7 items-center justify-center rounded-[6px] text-[var(--text-2)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-1)]"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* 中间：提示词输入 */}
        <textarea
          value={draft.prompt}
          onChange={(event) => setDraft({ ...draft, prompt: event.target.value })}
          placeholder="添加提示词，例如：在 $sentry 中查找崩溃"
          className="min-h-[200px] flex-1 resize-none bg-transparent px-5 py-4 text-[14px] leading-6 text-[var(--text-1)] outline-none placeholder:text-[var(--text-3)]"
        />

        {/* 底部：配置选项 + 操作按钮 */}
        <div className="flex items-center justify-between border-t border-[var(--border)] px-5 py-3">
          <div className="flex items-center gap-1.5">
            {/* 定时计划 */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setScheduleOpen((v) => !v)}
                className="flex h-7 items-center gap-1.5 rounded-[6px] border border-[var(--border)] bg-[var(--surface-1)] px-2 text-[12px] text-[var(--text-2)] transition-colors hover:bg-[var(--surface-2)]"
              >
                <Clock3 size={12} className="text-[var(--text-3)]" />
                {scheduleLabelForDraft(draft.scheduleFrequency, draft.scheduleMinute, draft.scheduleDayOfWeek, draft.customCronExpr)}
              </button>
              {scheduleOpen && (
                <SchedulePickerPopup
                  frequency={draft.scheduleFrequency}
                  minuteOfDay={draft.scheduleMinute}
                  dayOfWeek={draft.scheduleDayOfWeek}
                  customCron={draft.customCronExpr}
                  onFrequencyChange={(f) => setDraft({ ...draft, scheduleFrequency: f })}
                  onMinuteChange={(m) => { setDraft({ ...draft, scheduleMinute: m }); setScheduleOpen(false) }}
                  onDayOfWeekChange={(d) => setDraft({ ...draft, scheduleDayOfWeek: d })}
                  onCustomCronChange={(c) => setDraft({ ...draft, customCronExpr: c })}
                  onClose={() => setScheduleOpen(false)}
                />
              )}
            </div>

            {/* 模型选择 */}
            <ShadcnSelect
              value={draft.defaultModel || '__none__'}
              onValueChange={(v) => setDraft({ ...draft, defaultModel: v === '__none__' ? '' : v })}
            >
              <ShadcnSelectTrigger className="h-7 w-auto gap-1 rounded-[6px] border-[var(--border)] bg-[var(--surface-1)] px-2 text-[12px] text-[var(--text-2)] shadow-none hover:bg-[var(--surface-2)] [&_svg:last-child]:size-3 [&_svg:last-child]:text-[var(--text-3)]">
                <Sparkles size={12} className="shrink-0 text-[var(--text-3)]" />
                <ShadcnSelectValue placeholder="默认模型" />
              </ShadcnSelectTrigger>
              <ShadcnSelectContent className="z-[100]">
                <ShadcnSelectItem value="__none__">默认模型</ShadcnSelectItem>
                {modelOptions.map((opt) => (
                  <ShadcnSelectItem key={opt.value} value={opt.value}>{opt.label}</ShadcnSelectItem>
                ))}
              </ShadcnSelectContent>
            </ShadcnSelect>

            {/* 推理强度 */}
            <ShadcnSelect
              value={draft.thinkingLevel}
              onValueChange={(v) => setDraft({ ...draft, thinkingLevel: v })}
            >
              <ShadcnSelectTrigger className="h-7 w-auto gap-1 rounded-[6px] border-[var(--border)] bg-[var(--surface-1)] px-2 text-[12px] text-[var(--text-2)] shadow-none hover:bg-[var(--surface-2)] [&_svg:last-child]:size-3 [&_svg:last-child]:text-[var(--text-3)]">
                <Brain size={12} className="shrink-0 text-[var(--text-3)]" />
                <ShadcnSelectValue />
              </ShadcnSelectTrigger>
              <ShadcnSelectContent className="z-[100]">
                {THINKING_LEVEL_OPTIONS.map((opt) => (
                  <ShadcnSelectItem key={opt.value} value={opt.value}>{opt.label}</ShadcnSelectItem>
                ))}
              </ShadcnSelectContent>
            </ShadcnSelect>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="h-7 rounded-[6px] px-3 text-[12px] font-medium text-[var(--text-2)] transition-colors hover:bg-[var(--surface-2)]"
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => onSubmit(draft)}
              disabled={submitting || !draft.name.trim() || !draft.prompt.trim()}
              className="flex h-7 items-center gap-1.5 rounded-[6px] bg-[var(--text-1)] px-3 text-[12px] font-semibold text-white transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting && <Loader2 size={13} className="animate-spin" />}
              {isEdit ? '保存' : '创建'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function SchedulePickerPopup({
  frequency,
  minuteOfDay,
  dayOfWeek,
  customCron,
  onFrequencyChange,
  onMinuteChange,
  onDayOfWeekChange,
  onCustomCronChange,
  onClose,
}: {
  frequency: string
  minuteOfDay: number
  dayOfWeek: number
  customCron: string
  onFrequencyChange: (f: string) => void
  onMinuteChange: (m: number) => void
  onDayOfWeekChange: (d: number) => void
  onCustomCronChange: (c: string) => void
  onClose: () => void
}) {
  const [freqOpen, setFreqOpen] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (listRef.current) {
      const active = listRef.current.querySelector('[data-active]')
      if (active) active.scrollIntoView({ block: 'center' })
    }
  }, [])

  const needsTime = frequency === 'daily' || frequency === 'weekday' || frequency === 'weekly'
  const selectedLabel = FREQUENCY_OPTIONS.find((f) => f.id === frequency)?.label ?? '每天'

  return (
    <>
      <div className="fixed inset-0 z-30" onClick={onClose} />
      <div className="absolute bottom-full left-0 mb-1.5 z-40 w-[176px] overflow-hidden rounded-[10px] border border-[var(--border)] bg-[var(--surface-1)] shadow-[0_8px_30px_rgba(28,32,58,0.16)]">
        {/* 频率选择 */}
        <div className="border-b border-[var(--border)]">
          <button
            type="button"
            onClick={() => setFreqOpen((v) => !v)}
            className="flex w-full items-center justify-between px-3 py-2 text-[13px] text-[var(--text-1)] hover:bg-[var(--surface-2)]"
          >
            {selectedLabel}
            <ChevronDown size={14} className={`text-[var(--text-3)] transition-transform ${freqOpen ? 'rotate-180' : ''}`} />
          </button>
          {freqOpen && (
            <div className="border-t border-[var(--border)]">
              {FREQUENCY_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => { onFrequencyChange(opt.id); setFreqOpen(false) }}
                  className="flex w-full items-center justify-between px-3 py-2 text-[13px] text-[var(--text-1)] hover:bg-[var(--surface-2)]"
                >
                  {opt.label}
                  {frequency === opt.id && <Check size={14} className="text-[var(--brand)]" />}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* 每周：选择周几 */}
        {!freqOpen && frequency === 'weekly' && (
          <div className="flex gap-1 border-b border-[var(--border)] px-2.5 py-2">
            {DOW_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => onDayOfWeekChange(opt.value)}
                className={`flex size-6 items-center justify-center rounded-[4px] text-[12px] ${
                  dayOfWeek === opt.value
                    ? 'bg-[var(--text-1)] text-white'
                    : 'text-[var(--text-2)] hover:bg-[var(--surface-2)]'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        )}

        {/* 时间列表或自定义输入 */}
        {!freqOpen && (
          frequency === 'custom' ? (
            <div className="p-2.5">
              <input
                value={customCron}
                onChange={(e) => onCustomCronChange(e.target.value)}
                placeholder="0 9 * * *"
                className="w-full rounded-[6px] border border-[var(--border)] bg-transparent px-2 py-1.5 text-[13px] text-[var(--text-1)] outline-none placeholder:text-[var(--text-3)]"
              />
            </div>
          ) : needsTime ? (
            <div ref={listRef} className="max-h-[200px] overflow-y-auto p-1">
              {TIME_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  data-active={opt.value === minuteOfDay ? '' : undefined}
                  onClick={() => onMinuteChange(opt.value)}
                  className={`flex w-full items-center rounded-[4px] px-2.5 py-1.5 text-[13px] ${
                    opt.value === minuteOfDay
                      ? 'bg-[var(--surface-2)] font-medium text-[var(--text-1)]'
                      : 'text-[var(--text-2)] hover:bg-[var(--surface-2)]'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          ) : null
        )}
      </div>
    </>
  )
}

function createEmptyDraft(workspaceId: string): CreateDraft {
  return {
    name: '',
    prompt: '',
    scheduleFrequency: 'daily',
    scheduleMinute: 540,
    scheduleDayOfWeek: 1,
    customCronExpr: '',
    workspaceId,
    defaultModel: '',
    thinkingLevel: 'off',
  }
}

function scheduleForDraft(frequency: string, minuteOfDay: number, dayOfWeek: number, customCron: string): AutomationSchedule {
  const hour = Math.floor(minuteOfDay / 60)
  const minute = minuteOfDay % 60
  switch (frequency) {
    case 'hourly': return { type: 'cron', cronExpr: '0 * * * *' }
    case 'daily': return { type: 'cron', cronExpr: `${minute} ${hour} * * *` }
    case 'weekday': return { type: 'cron', cronExpr: `${minute} ${hour} * * 1-5` }
    case 'weekly': return { type: 'cron', cronExpr: `${minute} ${hour} * * ${dayOfWeek}` }
    case 'custom': return { type: 'cron', cronExpr: customCron || '0 9 * * *' }
    default: return { type: 'cron', cronExpr: '0 9 * * *' }
  }
}

function frequencyForSchedule(schedule: AutomationSchedule): { frequency: string; minuteOfDay: number; dayOfWeek: number; customCron: string } {
  if (schedule.type !== 'cron' || !schedule.cronExpr) {
    return { frequency: 'daily', minuteOfDay: 540, dayOfWeek: 1, customCron: '' }
  }
  const parts = schedule.cronExpr.split(/\s+/)
  if (parts.length < 5) return { frequency: 'daily', minuteOfDay: 540, dayOfWeek: 1, customCron: '' }

  const minute = parseInt(parts[0], 10) || 0
  const hour = parseInt(parts[1], 10) || 0
  const dow = parts[4]

  if (dow === '1-5') return { frequency: 'weekday', minuteOfDay: hour * 60 + minute, dayOfWeek: 1, customCron: '' }
  if (schedule.cronExpr === '0 * * * *') return { frequency: 'hourly', minuteOfDay: 0, dayOfWeek: 1, customCron: '' }
  if (dow === '*' && parts[2] === '*' && parts[3] === '*') return { frequency: 'daily', minuteOfDay: hour * 60 + minute, dayOfWeek: 1, customCron: '' }

  const dowNum = parseInt(dow, 10)
  if (dowNum >= 1 && dowNum <= 7 && parts[2] === '*') return { frequency: 'weekly', minuteOfDay: hour * 60 + minute, dayOfWeek: dowNum, customCron: '' }

  return { frequency: 'custom', minuteOfDay: hour * 60 + minute, dayOfWeek: 1, customCron: schedule.cronExpr }
}

function formatMinuteOfDay(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

function scheduleLabelForDraft(frequency: string, minuteOfDay: number, dayOfWeek: number, customCron: string): string {
  if (frequency === 'hourly') return '每小时'
  if (frequency === 'custom') return customCron || '自定义'
  if (frequency === 'weekly') {
    const dayLabel = DOW_OPTIONS.find((d) => d.value === dayOfWeek)?.label ?? '一'
    return `每周${dayLabel} ${formatMinuteOfDay(minuteOfDay)}`
  }
  const freqLabel = FREQUENCY_OPTIONS.find((f) => f.id === frequency)?.label ?? ''
  return `${freqLabel} ${formatMinuteOfDay(minuteOfDay)}`
}

function scheduleLabel(schedule: AutomationSchedule): string {
  if (schedule.type === 'once') return '一次性'
  if (schedule.type === 'interval') return `每 ${Math.max(1, Math.round((schedule.intervalMs ?? 60_000) / 60_000))} 分钟`
  if (schedule.type !== 'cron' || !schedule.cronExpr) return '手动'

  const { frequency, minuteOfDay, dayOfWeek } = frequencyForSchedule(schedule)
  if (frequency === 'hourly') return '每小时'
  if (frequency === 'custom') return schedule.cronExpr
  if (frequency === 'weekly') {
    const dayLabel = DOW_OPTIONS.find((d) => d.value === dayOfWeek)?.label ?? '一'
    return `每周${dayLabel} ${formatMinuteOfDay(minuteOfDay)}`
  }

  const freqLabel = FREQUENCY_OPTIONS.find((f) => f.id === frequency)?.label ?? ''
  return `${freqLabel} ${formatMinuteOfDay(minuteOfDay)}`
}

function automationSourceLabel(job: AutomationJob): string {
  return isSystemAutomationJob(job) ? '系统日程' : '用户创建'
}

function isSystemAutomationJob(job: AutomationJob): boolean {
  return job.source === 'system' || job.systemAction === 'routine'
}

function automationModuleLabel(job: AutomationJob): string | null {
  return isSystemAutomationJob(job) ? '日程' : null
}

function isCompletedAutomationJob(job: AutomationJob): boolean {
  return job.schedule.type === 'once' && Boolean(job.lastRunAt)
}

function automationJobStatusLabel(job: AutomationJob): string | null {
  if (job.schedule.type === 'once') {
    if (job.lastRunAt) return '已完成'
    if ((job.schedule.runAt ?? 0) < Date.now()) return '已过期'
  }
  return job.enabled ? null : '已停用'
}

function summarizePrompt(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, ' ').trim()
  return normalized.length > 34 ? `${normalized.slice(0, 34)}...` : normalized
}

function upsertAutomationJob(jobs: AutomationJob[], job: AutomationJob): AutomationJob[] {
  const next = jobs.some((item) => item.id === job.id)
    ? jobs.map((item) => (item.id === job.id ? job : item))
    : [job, ...jobs]
  return next.sort((left, right) => right.updatedAt - left.updatedAt)
}

function formatShortTime(timestamp: number): string {
  const date = new Date(timestamp)
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startOfYesterday = startOfToday - 86_400_000
  const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })

  if (timestamp >= startOfToday) return `今天 ${time}`
  if (timestamp >= startOfYesterday) return `昨天 ${time}`
  return date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
}
