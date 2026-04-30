import { useCallback, useEffect, useMemo, useState } from 'react'
import type * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import {
  BookOpen,
  Check,
  Clock3,
  Code2,
  Database,
  ExternalLink,
  FileText,
  Folder,
  Globe2,
  Loader2,
  Megaphone,
  MessageCircle,
  PencilLine,
  Play,
  Plus,
  Share2,
  UsersRound,
  X,
  type LucideIcon,
} from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { agentWorkspacesAtom } from '@/atoms'
import { agentPendingInteractiveAtom } from '@/atoms'
import { automationJobsAtom, automationRunsAtom } from '@/atoms/automation-atoms'
import { useAutomationListeners } from '@/hooks/useAutomationListeners'
import {
  createAutomationJob,
  runAutomationJobNow,
  updateAutomationJob,
} from '@/lib/desktop-api/automation'
import type {
  AutomationJob,
  AutomationRun,
  AutomationSchedule,
  AutomationTriggerMode,
} from '@lume/shared'
import { buildAutomationApprovalSummaries, type AutomationApprovalSummary } from './automation-approval-state'

type ResourceId = 'file' | 'web' | 'code' | 'knowledge' | 'prd' | 'design' | 'project'

interface WorkspaceOption {
  id: string
  name: string
}

interface AutomationTaskView {
  id: string
  job?: AutomationJob
  name: string
  description: string
  prompt: string
  workspaceId: string
  model: string
  runModes: AutomationTriggerMode[]
  toolResourceIds: ResourceId[]
  tags: string[]
  timeLabel: string
  statusLabel: string
  icon: LucideIcon
}

interface AutomationTaskDraft {
  name: string
  description: string
  prompt: string
  workspaceId: string
  model: string
  runModes: AutomationTriggerMode[]
  toolResourceIds: ResourceId[]
}

const MODEL_OPTIONS = ['GPT-5.1', 'GPT-5.4', 'Claude Sonnet 4', '继承当前模型']

const RUN_MODE_OPTIONS: Array<{
  id: AutomationTriggerMode
  title: string
  desc: string
  icon: LucideIcon
}> = [
  { id: 'manual', title: '手动运行', desc: '手动触发执行', icon: Play },
  { id: 'schedule', title: '定时', desc: '按设定时间运行', icon: Clock3 },
  { id: 'webhook', title: 'Webhook', desc: '通过 Webhook 触发', icon: Share2 },
  { id: 'chat', title: '对话中调用', desc: '在对话中调用', icon: MessageCircle },
]

const RESOURCE_OPTIONS: Array<{
  id: ResourceId
  title: string
  icon: LucideIcon
  accent: string
}> = [
  { id: 'file', title: '文件', icon: Folder, accent: 'text-[#ff8a1f]' },
  { id: 'web', title: '网页搜索', icon: Globe2, accent: 'text-[#5d62ff]' },
  { id: 'code', title: '代码分析', icon: Code2, accent: 'text-[#5d62ff]' },
  { id: 'knowledge', title: '知识库', icon: BookOpen, accent: 'text-[#5d62ff]' },
  { id: 'prd', title: '产品需求库', icon: Database, accent: 'text-[#4f54ff]' },
  { id: 'design', title: '设计规范', icon: Folder, accent: 'text-[#5d62ff]' },
  { id: 'project', title: '项目文档', icon: Folder, accent: 'text-[#5d62ff]' },
]

const TEMPLATE_TASKS: AutomationTaskView[] = [
  {
    id: 'template-prd',
    name: 'PRD 初稿生成',
    description: '根据需求文档，生成产品需求文档初稿',
    prompt: '阅读并理解需求文档，提炼核心目标、用户价值与业务场景，整理功能清单与需求细节，输出结构清晰、条理完整的 PRD 初稿，语言简洁、专业。',
    workspaceId: '',
    model: 'GPT-5.1',
    runModes: ['manual', 'chat'],
    toolResourceIds: ['file', 'web', 'code', 'knowledge', 'prd', 'design', 'project'],
    tags: ['产品', '文档生成'],
    timeLabel: '今天 10:24',
    statusLabel: '成功',
    icon: FileText,
  },
  {
    id: 'template-release',
    name: '发布说明整理',
    description: '汇总本次迭代的变更亮点并生成发布说明',
    prompt: '读取迭代记录和变更文档，提炼用户可感知的新增、优化与修复内容，生成结构清晰的发布说明。',
    workspaceId: '',
    model: 'GPT-5.1',
    runModes: ['manual'],
    toolResourceIds: ['file', 'prd'],
    tags: ['运营', '文档总结'],
    timeLabel: '今天 09:18',
    statusLabel: '成功',
    icon: Megaphone,
  },
  {
    id: 'template-code',
    name: '代码变更分析',
    description: '分析代码 Diff，生成变更影响与风险',
    prompt: '分析当前代码 Diff，识别核心变化、影响范围、潜在风险和建议的验证项。',
    workspaceId: '',
    model: 'GPT-5.1',
    runModes: ['manual'],
    toolResourceIds: ['code', 'file'],
    tags: ['研发', '代码分析'],
    timeLabel: '昨天 15:33',
    statusLabel: '成功',
    icon: Code2,
  },
  {
    id: 'template-feedback',
    name: '用户反馈总结',
    description: '聚合用户反馈，提炼共性问题与建议',
    prompt: '归纳用户反馈，按问题类型聚类，输出优先级、典型表述和建议动作。',
    workspaceId: '',
    model: 'GPT-5.1',
    runModes: ['manual', 'chat'],
    toolResourceIds: ['file', 'web', 'prd'],
    tags: ['产品', '调研分析'],
    timeLabel: '昨天 15:07',
    statusLabel: '成功',
    icon: UsersRound,
  },
  {
    id: 'template-design',
    name: '设计评审总结',
    description: '总结设计评审要点与意见',
    prompt: '整理设计评审记录，提炼关键争议、已确认结论、待跟进问题和下一步建议。',
    workspaceId: '',
    model: 'GPT-5.1',
    runModes: ['manual'],
    toolResourceIds: ['file', 'design', 'project'],
    tags: ['设计', '评审总结'],
    timeLabel: '昨天 11:05',
    statusLabel: '成功',
    icon: PencilLine,
  },
]

export function AutomationManagementView() {
  useAutomationListeners()

  const workspaces = useAtomValue(agentWorkspacesAtom)
  const jobs = useAtomValue(automationJobsAtom)
  const runs = useAtomValue(automationRunsAtom)
  const pendingInteractive = useAtomValue(agentPendingInteractiveAtom)
  const setJobs = useSetAtom(automationJobsAtom)
  const setRuns = useSetAtom(automationRunsAtom)
  const [selectedTaskId, setSelectedTaskId] = useState(TEMPLATE_TASKS[0].id)
  const [detailDraft, setDetailDraft] = useState<AutomationTaskDraft | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [busyAction, setBusyAction] = useState<'save' | 'run' | 'modal' | null>(null)

  const workspaceOptions = useMemo<WorkspaceOption[]>(() => {
    if (workspaces.length > 0) {
      return workspaces.map((workspace) => ({ id: workspace.id, name: workspace.name }))
    }
    return [{ id: '', name: 'Lume Core' }]
  }, [workspaces])

  const tasks = useMemo(
    () => buildAutomationTasks(jobs, runs, workspaceOptions),
    [jobs, runs, workspaceOptions],
  )
  const selectedTask = tasks.find((task) => task.id === selectedTaskId) ?? tasks[0]
  const pendingApprovals = useMemo(
    () => buildAutomationApprovalSummaries(pendingInteractive, jobs),
    [jobs, pendingInteractive],
  )
  const effectiveDraft = detailDraft ?? (selectedTask ? toDraft(selectedTask, workspaceOptions[0]?.id ?? '') : null)
  const selectedRuns = selectedTask?.job
    ? runs.filter((run) => run.jobId === selectedTask.job?.id).slice(0, 2)
    : []

  useEffect(() => {
    if (!tasks.some((task) => task.id === selectedTaskId)) {
      setSelectedTaskId(tasks[0]?.id ?? TEMPLATE_TASKS[0].id)
    }
  }, [selectedTaskId, tasks])

  useEffect(() => {
    if (!selectedTask) return
    setDetailDraft(toDraft(selectedTask, workspaceOptions[0]?.id ?? ''))
  }, [selectedTask?.id, selectedTask?.job?.updatedAt, workspaceOptions])

  const persistDraft = useCallback(async (task: AutomationTaskView, draft: AutomationTaskDraft) => {
    const schedule = scheduleForDraft(draft, task.job)
    const workspaceId = draft.workspaceId || undefined

    if (task.job) {
      const updated = await updateAutomationJob({
        id: task.job.id,
        name: draft.name,
        description: draft.description,
        prompt: draft.prompt,
        workspaceId,
        schedule,
        triggerModes: draft.runModes,
        toolResourceIds: draft.toolResourceIds,
        defaultModel: draft.model,
      })
      setJobs((previous) => upsertAutomationJob(previous, updated))
      return updated
    }

    const created = await createAutomationJob({
      name: draft.name,
      description: draft.description,
      prompt: draft.prompt,
      workspaceId,
      schedule,
      triggerModes: draft.runModes,
      toolResourceIds: draft.toolResourceIds,
      defaultModel: draft.model,
    })
    setJobs((previous) => upsertAutomationJob(previous, created))
    setSelectedTaskId(created.id)
    return created
  }, [setJobs])

  const handleSave = useCallback(async () => {
    if (!selectedTask || !effectiveDraft || !isDraftValid(effectiveDraft)) return
    setBusyAction('save')
    try {
      await persistDraft(selectedTask, effectiveDraft)
    } catch (error) {
      console.error('[AutomationManagementView] 保存自动化任务失败:', error)
    } finally {
      setBusyAction(null)
    }
  }, [effectiveDraft, persistDraft, selectedTask])

  const handleRunNow = useCallback(async () => {
    if (!selectedTask || !effectiveDraft || !isDraftValid(effectiveDraft)) return
    setBusyAction('run')
    try {
      const job = await persistDraft(selectedTask, effectiveDraft)
      const run = await runAutomationJobNow(job.id)
      setRuns((previous) => [run, ...previous.filter((item) => item.id !== run.id)].slice(0, 50))
    } catch (error) {
      console.error('[AutomationManagementView] 执行自动化任务失败:', error)
    } finally {
      setBusyAction(null)
    }
  }, [effectiveDraft, persistDraft, selectedTask, setRuns])

  const handleCreateFromModal = useCallback(async (draft: AutomationTaskDraft, runAfterCreate: boolean) => {
    if (!isDraftValid(draft)) return
    setBusyAction('modal')
    try {
      const created = await createAutomationJob({
        name: draft.name,
        description: draft.description,
        prompt: draft.prompt,
        workspaceId: draft.workspaceId || undefined,
        schedule: scheduleForDraft(draft),
        triggerModes: draft.runModes,
        toolResourceIds: draft.toolResourceIds,
        defaultModel: draft.model,
      })
      setJobs((previous) => upsertAutomationJob(previous, created))
      setSelectedTaskId(created.id)
      setModalOpen(false)

      if (runAfterCreate) {
        const run = await runAutomationJobNow(created.id)
        setRuns((previous) => [run, ...previous.filter((item) => item.id !== run.id)].slice(0, 50))
      }
    } catch (error) {
      console.error('[AutomationManagementView] 创建自动化任务失败:', error)
    } finally {
      setBusyAction(null)
    }
  }, [setJobs, setRuns])

  if (!selectedTask || !effectiveDraft) return null

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[var(--background)]">
      <ScrollArea className="min-h-0 flex-1">
        <main className="relative flex w-full min-w-[1180px] flex-col gap-4 px-8 py-4">
          <div className="absolute left-1/2 top-4 -translate-x-1/2 rounded-full border border-[var(--border)] bg-[var(--surface-1)] px-5 py-2 text-[13px] font-medium text-[var(--text-3)] shadow-[0_2px_10px_rgba(35,40,80,0.04)]">
            <span className="mr-2 inline-block size-2 rounded-full bg-[#22c983]" />
            已同步
          </div>

          <header className="flex items-start justify-between gap-6 pt-8">
            <div>
              <h1 className="text-[22px] font-semibold leading-7 text-[var(--text-1)]">Agent 自动化</h1>
              <p className="mt-2 text-[13px] leading-5 text-[var(--text-2)]">
                创建可复用的 Agent 任务，按需运行或在对话中调用。
              </p>
            </div>
            <button
              type="button"
              onClick={() => setModalOpen(true)}
              className="flex h-10 shrink-0 items-center gap-2 rounded-[8px] bg-[var(--brand)] px-5 text-[14px] font-semibold text-white shadow-[0_14px_30px_-20px_rgba(79,84,255,0.9)] transition-colors hover:brightness-110"
            >
              <Plus size={18} />
              新建任务
            </button>
          </header>

          {pendingApprovals.length > 0 && (
            <AutomationApprovalBanner approvals={pendingApprovals} />
          )}

          <div className="grid min-h-[690px] grid-cols-[280px_minmax(640px,1fr)] gap-6">
            <AutomationTaskList
              tasks={tasks}
              selectedTaskId={selectedTask.id}
              running={busyAction === 'run'}
              onSelect={setSelectedTaskId}
              onRun={handleRunNow}
            />

            <AutomationTaskDetail
              task={selectedTask}
              draft={effectiveDraft}
              runs={selectedRuns}
              workspaceOptions={workspaceOptions}
              saving={busyAction === 'save'}
              running={busyAction === 'run'}
              onDraftChange={setDetailDraft}
              onReset={() => setDetailDraft(toDraft(selectedTask, workspaceOptions[0]?.id ?? ''))}
              onSave={handleSave}
              onRun={handleRunNow}
            />
          </div>
        </main>
      </ScrollArea>

      <AutomationTaskModal
        open={modalOpen}
        workspaceOptions={workspaceOptions}
        submitting={busyAction === 'modal'}
        onCancel={() => setModalOpen(false)}
        onSubmit={handleCreateFromModal}
      />
    </div>
  )
}

function AutomationApprovalBanner({ approvals }: { approvals: AutomationApprovalSummary[] }) {
  return (
    <section className="rounded-[10px] border border-amber-400/35 bg-amber-400/[0.08] px-4 py-3 text-[13px] text-[var(--text-2)]">
      <div className="flex items-start gap-3">
        <span className="mt-1 size-2 rounded-full bg-amber-500" />
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-[var(--text-1)]">有 {approvals.length} 个自动化任务等待确认</p>
          <p className="mt-1 leading-5 text-[var(--text-2)]">
            高风险动作已暂停。请到对应 Agent 线程里的确认卡片处理，确认后任务会尝试继续。
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {approvals.slice(0, 4).map((approval) => (
              <span
                key={approval.requestId}
                className="inline-flex items-center gap-1.5 rounded-full border border-amber-400/25 bg-[var(--surface-1)] px-2.5 py-1 text-[12px] text-[var(--text-2)]"
              >
                <ExternalLink size={12} />
                {approval.jobName ?? approval.jobId ?? approval.threadId} · {approval.toolName}
              </span>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}

function AutomationTaskList({
  tasks,
  selectedTaskId,
  running,
  onSelect,
  onRun,
}: {
  tasks: AutomationTaskView[]
  selectedTaskId: string
  running: boolean
  onSelect: (taskId: string) => void
  onRun: () => void
}) {
  return (
    <section className="space-y-4">
      {tasks.map((task) => {
        const Icon = task.icon
        const selected = task.id === selectedTaskId

        return (
          <button
            key={task.id}
            type="button"
            onClick={() => onSelect(task.id)}
            className={cn(
              'flex h-[132px] w-full items-center gap-4 rounded-[8px] border bg-[var(--surface-1)] px-4 text-left transition-all',
              selected
                ? 'border-[color-mix(in_oklab,var(--brand)_40%,var(--border-strong))] bg-[color-mix(in_oklab,var(--brand)_10%,var(--surface-1))] shadow-[0_14px_34px_-30px_rgba(79,84,255,0.8)]'
                : 'border-[var(--border)] hover:border-[color-mix(in_oklab,var(--brand)_25%,var(--border-strong))] hover:bg-[color-mix(in_oklab,var(--brand)_10%,var(--surface-1))]',
            )}
          >
            <span className="flex size-[46px] min-w-[46px] items-center justify-center rounded-[8px] border border-[var(--border)] bg-[var(--surface-1)] text-[var(--brand)]">
              <Icon size={24} strokeWidth={1.8} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[15px] font-semibold leading-5 text-[var(--text-1)]">{task.name}</span>
              <span className="mt-2 block truncate text-[12px] leading-5 text-[var(--text-2)]">{task.description}</span>
              <span className="mt-2 flex flex-wrap gap-1.5">
                {task.tags.map((tag) => (
                  <span
                    key={tag}
                    className="rounded-full bg-[var(--surface-2)] px-2 py-0.5 text-[11px] font-medium text-[var(--text-3)]"
                  >
                    {tag}
                  </span>
                ))}
              </span>
              <span className="mt-3 flex items-center gap-4 text-[12px] text-[var(--text-2)]">
                <span>{task.timeLabel}</span>
                <span className="flex items-center gap-1.5">
                  <span className="size-1.5 rounded-full bg-[#22c983]" />
                  {task.statusLabel}
                </span>
              </span>
            </span>
            <span
              role="button"
              tabIndex={0}
              onClick={(event) => {
                event.stopPropagation()
                if (selected) void onRun()
                else onSelect(task.id)
              }}
              className="flex size-10 min-w-10 items-center justify-center rounded-full border border-[color-mix(in_oklab,var(--brand)_22%,var(--border-strong))] bg-[var(--surface-1)] text-[var(--brand)] transition-colors hover:bg-[color-mix(in_oklab,var(--brand)_10%,var(--surface-1))]"
            >
              {running && selected ? <Loader2 size={18} className="animate-spin" /> : <Play size={18} fill="currentColor" />}
            </span>
          </button>
        )
      })}
    </section>
  )
}

function AutomationTaskDetail({
  task,
  draft,
  runs,
  workspaceOptions,
  saving,
  running,
  onDraftChange,
  onReset,
  onSave,
  onRun,
}: {
  task: AutomationTaskView
  draft: AutomationTaskDraft
  runs: AutomationRun[]
  workspaceOptions: WorkspaceOption[]
  saving: boolean
  running: boolean
  onDraftChange: (draft: AutomationTaskDraft) => void
  onReset: () => void
  onSave: () => void
  onRun: () => void
}) {
  const runRows = runs.length > 0
    ? runs.map((run) => ({
        id: run.id,
        time: formatRunTime(run.startedAt),
        source: run.trigger === 'manual' ? '手动运行' : '定时运行',
        status: run.status === 'success' ? '成功' : run.status === 'failed' ? '失败' : '跳过',
      }))
    : [
        { id: `${task.id}:sample-1`, time: '今天 10:24', source: '手动运行', status: '成功' },
        { id: `${task.id}:sample-2`, time: '昨天 14:11', source: '手动运行', status: '成功' },
      ]

  return (
    <section className="flex min-w-0 flex-col gap-2">
      <Panel>
        <SectionTitle marker="A" title="基本信息" />
        <div className="mt-3 grid grid-cols-[130px_minmax(0,1fr)] gap-x-5 gap-y-2.5">
          <FieldLabel>任务名称</FieldLabel>
          <input
            value={draft.name}
            onChange={(event) => onDraftChange({ ...draft, name: event.target.value })}
            className="h-7 bg-transparent text-[13px] font-medium text-[var(--text-1)] outline-none"
          />
          <FieldLabel>简要说明</FieldLabel>
          <input
            value={draft.description}
            onChange={(event) => onDraftChange({ ...draft, description: event.target.value })}
            className="h-7 bg-transparent text-[13px] text-[var(--text-2)] outline-none"
          />
          <FieldLabel>运行方式（可多选）</FieldLabel>
          <RunModePicker
            value={draft.runModes}
            onChange={(runModes) => onDraftChange({ ...draft, runModes })}
            compact
          />
          <FieldLabel>默认工作区</FieldLabel>
          <SelectControl
            value={draft.workspaceId}
            options={workspaceOptions}
            onChange={(workspaceId) => onDraftChange({ ...draft, workspaceId })}
          />
          <FieldLabel>默认模型</FieldLabel>
          <SelectControl
            value={draft.model}
            options={MODEL_OPTIONS.map((model) => ({ id: model, name: model }))}
            onChange={(model) => onDraftChange({ ...draft, model })}
          />
        </div>
      </Panel>

      <Panel>
        <SectionTitle marker="B" title="Agent 指令" />
        <div className="mt-3 rounded-[8px] border border-[var(--border)] bg-[var(--surface-1)] p-3">
          <textarea
            value={draft.prompt}
            onChange={(event) => onDraftChange({ ...draft, prompt: event.target.value })}
            maxLength={2000}
            className="h-[56px] w-full resize-none bg-transparent text-[13px] leading-6 text-[var(--text-1)] outline-none"
          />
          <div className="text-right text-[12px] text-[var(--text-3)]">{draft.prompt.length}/2000</div>
        </div>
      </Panel>

      <Panel>
        <SectionTitle marker="C" title="工具与资源" />
        <ResourcePicker
          value={draft.toolResourceIds}
          onChange={(toolResourceIds) => onDraftChange({ ...draft, toolResourceIds })}
          className="mt-3"
        />
      </Panel>

      <Panel>
        <h2 className="text-[14px] font-semibold text-[var(--text-1)]">最近运行</h2>
        <div className="mt-3 overflow-hidden rounded-[8px] border border-[var(--border)]">
          <div className="grid h-9 grid-cols-[1fr_1fr_1fr_120px] items-center border-b border-[var(--border)] bg-[var(--surface-2)] px-4 text-[12px] font-medium text-[var(--text-3)]">
            <span>时间</span>
            <span>来源</span>
            <span>状态</span>
            <span>操作</span>
          </div>
          {runRows.map((row) => (
            <div
              key={row.id}
              className="grid h-10 grid-cols-[1fr_1fr_1fr_120px] items-center border-b border-[var(--border)] px-4 text-[12px] text-[var(--text-2)] last:border-b-0"
            >
              <span>{row.time}</span>
              <span>{row.source}</span>
              <span className="flex items-center gap-1.5">
                <span className="size-1.5 rounded-full bg-[#22c983]" />
                {row.status}
              </span>
              <button type="button" className="text-left font-medium text-[var(--brand)]">
                查看结果
              </button>
            </div>
          ))}
        </div>
      </Panel>

      <div className="mt-auto grid h-12 grid-cols-[1fr_1.15fr_1.2fr] gap-4">
        <button
          type="button"
          onClick={onReset}
          className="rounded-[8px] border border-[var(--border)] bg-[var(--surface-1)] text-[14px] font-medium text-[var(--text-2)] transition-colors hover:bg-[var(--surface-2)]"
        >
          取消
        </button>
        <button
          type="button"
          onClick={onRun}
          disabled={running || !isDraftValid(draft)}
          className="flex items-center justify-center gap-2 rounded-[8px] border border-[color-mix(in_oklab,var(--brand)_40%,var(--border-strong))] bg-[var(--surface-1)] text-[14px] font-semibold text-[var(--brand)] transition-colors hover:bg-[color-mix(in_oklab,var(--brand)_10%,var(--surface-1))] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {running && <Loader2 size={16} className="animate-spin" />}
          立即运行
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={saving || !isDraftValid(draft)}
          className="flex items-center justify-center gap-2 rounded-[8px] bg-[var(--brand)] text-[14px] font-semibold text-white transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {saving && <Loader2 size={16} className="animate-spin" />}
          保存任务
        </button>
      </div>
    </section>
  )
}

export function AutomationTaskModal({
  open,
  workspaceOptions,
  submitting,
  onCancel,
  onSubmit,
}: {
  open: boolean
  workspaceOptions: WorkspaceOption[]
  submitting: boolean
  onCancel: () => void
  onSubmit: (draft: AutomationTaskDraft, runAfterCreate: boolean) => void
}) {
  const [draft, setDraft] = useState<AutomationTaskDraft>(() => createEmptyDraft(workspaceOptions[0]?.id ?? ''))

  useEffect(() => {
    if (open) {
      setDraft(createEmptyDraft(workspaceOptions[0]?.id ?? ''))
    }
  }, [open, workspaceOptions])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/28 backdrop-blur-[2px]" onClick={onCancel}>
      <div
        className="w-full max-w-[760px] rounded-[10px] border border-[var(--border)] bg-[var(--surface-1)] p-7 shadow-[0_28px_80px_rgba(27,32,58,0.24)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-[18px] font-semibold leading-6 text-[var(--text-1)]">新建任务</h2>
            <p className="mt-2 text-[13px] leading-5 text-[var(--text-2)]">
              创建一个可复用的 Agent 任务，支持手动、定时、Webhook 和对话中调用。
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="flex size-8 items-center justify-center rounded-[8px] text-[var(--text-2)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-1)]"
          >
            <X size={18} />
          </button>
        </div>

        <div className="mt-6 grid grid-cols-2 gap-4">
          <LabeledInput
            label="任务名称"
            value={draft.name}
            onChange={(name) => setDraft({ ...draft, name })}
          />
          <LabeledInput
            label="简短描述"
            value={draft.description}
            onChange={(description) => setDraft({ ...draft, description })}
          />
        </div>

        <div className="mt-5">
          <FormLabel>运行方式（可多选）</FormLabel>
          <RunModePicker
            value={draft.runModes}
            onChange={(runModes) => setDraft({ ...draft, runModes })}
            className="mt-2"
          />
        </div>

        <div className="mt-5 grid grid-cols-2 gap-4">
          <div>
            <FormLabel>默认工作区</FormLabel>
            <SelectControl
              value={draft.workspaceId}
              options={workspaceOptions}
              onChange={(workspaceId) => setDraft({ ...draft, workspaceId })}
              className="mt-2"
            />
          </div>
          <div>
            <FormLabel>默认模型</FormLabel>
            <SelectControl
              value={draft.model}
              options={MODEL_OPTIONS.map((model) => ({ id: model, name: model }))}
              onChange={(model) => setDraft({ ...draft, model })}
              className="mt-2"
            />
          </div>
        </div>

        <div className="mt-5">
          <FormLabel>Agent 指令</FormLabel>
          <div className="mt-2 rounded-[8px] border border-[var(--border)] bg-[var(--surface-1)] p-4">
            <textarea
              value={draft.prompt}
              onChange={(event) => setDraft({ ...draft, prompt: event.target.value })}
              maxLength={2000}
              className="h-[72px] w-full resize-none bg-transparent text-[13px] leading-6 text-[var(--text-1)] outline-none"
            />
            <div className="text-right text-[12px] text-[var(--text-3)]">{draft.prompt.length}/2000</div>
          </div>
        </div>

        <div className="mt-5">
          <FormLabel>工具与资源</FormLabel>
          <ResourcePicker
            value={draft.toolResourceIds}
            onChange={(toolResourceIds) => setDraft({ ...draft, toolResourceIds })}
            className="mt-2"
          />
        </div>

        <div className="mt-7 grid grid-cols-[138px_146px_1fr] justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="h-10 rounded-[8px] border border-[var(--border)] bg-[var(--surface-1)] text-[13px] font-medium text-[var(--text-2)] transition-colors hover:bg-[var(--surface-2)]"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => onSubmit(draft, false)}
            disabled={submitting || !isDraftValid(draft)}
            className="flex h-10 items-center justify-center gap-2 rounded-[8px] bg-[var(--brand)] text-[13px] font-semibold text-white transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting && <Loader2 size={15} className="animate-spin" />}
            创建任务
          </button>
          <button
            type="button"
            onClick={() => onSubmit(draft, true)}
            disabled={submitting || !isDraftValid(draft)}
            className="h-10 rounded-[8px] bg-[var(--surface-1)] text-[13px] font-medium text-[var(--text-2)] transition-colors hover:bg-[var(--surface-2)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            创建并运行
          </button>
        </div>
      </div>
    </div>
  )
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-[8px] border border-[var(--border)] bg-[var(--surface-1)] p-4 shadow-[0_1px_2px_rgba(31,35,70,0.02)]">
      {children}
    </div>
  )
}

function SectionTitle({ marker, title }: { marker: string; title: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="flex size-5 items-center justify-center rounded-full bg-[var(--brand)] text-[11px] font-bold text-white">
        {marker}
      </span>
      <h2 className="text-[14px] font-semibold text-[var(--text-1)]">{title}</h2>
    </div>
  )
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <div className="flex h-7 items-center text-[13px] text-[var(--text-2)]">{children}</div>
}

function FormLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-[13px] font-semibold text-[var(--text-1)]">{children}</div>
}

function LabeledInput({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (value: string) => void
}) {
  return (
    <div>
      <FormLabel>{label}</FormLabel>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-2 h-10 w-full rounded-[8px] border border-[var(--border)] bg-[var(--surface-1)] px-3 text-[13px] text-[var(--text-1)] outline-none transition-colors focus:border-[var(--border)]"
      />
    </div>
  )
}

function RunModePicker({
  value,
  onChange,
  className,
  compact,
}: {
  value: AutomationTriggerMode[]
  onChange: (value: AutomationTriggerMode[]) => void
  className?: string
  compact?: boolean
}) {
  return (
    <div className={cn('grid grid-cols-4 gap-3', className)}>
      {RUN_MODE_OPTIONS.map((mode) => {
        const selected = value.includes(mode.id)
        const Icon = mode.icon

        return (
          <button
            key={mode.id}
            type="button"
            onClick={() => onChange(toggleListValue(value, mode.id, 'manual'))}
            className={cn(
              'relative rounded-[8px] border bg-[var(--surface-1)] p-3 text-left transition-colors',
              compact ? 'h-[92px] p-2.5' : 'h-[98px]',
              selected ? 'border-[color-mix(in_oklab,var(--brand)_40%,var(--border-strong))] bg-[color-mix(in_oklab,var(--brand)_10%,var(--surface-1))]' : 'border-[var(--border)] hover:border-[color-mix(in_oklab,var(--brand)_25%,var(--border-strong))]',
            )}
          >
            <span className={cn(
              'flex items-center justify-center rounded-full',
              compact ? 'size-5' : 'size-6',
              selected ? 'bg-[var(--brand)] text-white' : 'text-[var(--text-1)]',
            )}>
              <Icon size={compact ? 13 : 15} />
            </span>
            <span className={cn('block font-semibold text-[var(--text-1)]', compact ? 'mt-2.5 text-[12px] leading-4' : 'mt-4 text-[13px]')}>
              {mode.title}
            </span>
            <span className={cn('mt-0.5 block text-[var(--text-2)]', compact ? 'text-[10px] leading-4' : 'text-[11px]')}>
              {mode.desc}
            </span>
            {selected && (
              <span className={cn(
                'absolute flex items-center justify-center rounded-full bg-[var(--brand)] text-white',
                compact ? 'right-2.5 top-2.5 size-4' : 'right-3 top-3 size-5',
              )}>
                <Check size={compact ? 11 : 13} strokeWidth={2.4} />
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

function ResourcePicker({
  value,
  onChange,
  className,
}: {
  value: ResourceId[]
  onChange: (value: ResourceId[]) => void
  className?: string
}) {
  return (
    <div className={cn('flex flex-wrap gap-2', className)}>
      {RESOURCE_OPTIONS.map((resource) => {
        const selected = value.includes(resource.id)
        const Icon = resource.icon

        return (
          <button
            key={resource.id}
            type="button"
            onClick={() => onChange(toggleListValue(value, resource.id, 'file'))}
            className={cn(
              'flex h-9 items-center gap-2 rounded-[8px] border bg-[var(--surface-1)] px-3 text-[12px] font-medium transition-colors',
              selected
                ? 'border-[color-mix(in_oklab,var(--brand)_40%,var(--border-strong))] bg-[color-mix(in_oklab,var(--brand)_10%,var(--surface-1))] text-[var(--brand)]'
                : 'border-[var(--border)] text-[var(--text-2)] hover:border-[color-mix(in_oklab,var(--brand)_25%,var(--border-strong))]',
            )}
          >
            <Icon size={15} className={selected ? 'text-[var(--brand)]' : resource.accent} />
            {resource.title}
          </button>
        )
      })}
    </div>
  )
}

function SelectControl({
  value,
  options,
  onChange,
  className,
}: {
  value: string
  options: WorkspaceOption[]
  onChange: (value: string) => void
  className?: string
}) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className={cn(
        'h-9 w-full rounded-[8px] border border-[var(--border)] bg-[var(--surface-1)] px-3 text-[13px] text-[var(--text-1)] outline-none transition-colors focus:border-[var(--border)]',
        className,
      )}
    >
      {options.map((option) => (
        <option key={option.id || option.name} value={option.id}>
          {option.name}
        </option>
      ))}
    </select>
  )
}

function buildAutomationTasks(
  jobs: AutomationJob[],
  runs: AutomationRun[],
  workspaceOptions: WorkspaceOption[],
): AutomationTaskView[] {
  if (jobs.length === 0) {
    const defaultWorkspaceId = workspaceOptions[0]?.id ?? ''
    return TEMPLATE_TASKS.map((task) => ({ ...task, workspaceId: defaultWorkspaceId }))
  }

  return jobs.map((job, index) => {
    const run = runs.find((item) => item.jobId === job.id)
    return {
      id: job.id,
      job,
      name: job.name,
      description: job.description ?? summarizePrompt(job.prompt),
      prompt: job.prompt,
      workspaceId: job.workspaceId ?? workspaceOptions[0]?.id ?? '',
      model: job.defaultModel ?? 'GPT-5.1',
      runModes: deriveRunModes(job),
      toolResourceIds: sanitizeResourceIds(job.toolResourceIds),
      tags: deriveTags(job),
      timeLabel: run ? formatRunTime(run.startedAt) : formatRunTime(job.updatedAt),
      statusLabel: run ? statusText(run.status) : job.enabled ? '成功' : '已停用',
      icon: TEMPLATE_TASKS[index % TEMPLATE_TASKS.length].icon,
    }
  })
}

function toDraft(task: AutomationTaskView, fallbackWorkspaceId: string): AutomationTaskDraft {
  return {
    name: task.name,
    description: task.description,
    prompt: task.prompt,
    workspaceId: task.workspaceId || fallbackWorkspaceId,
    model: task.model,
    runModes: task.runModes.length > 0 ? task.runModes : ['manual'],
    toolResourceIds: task.toolResourceIds.length > 0 ? task.toolResourceIds : ['file'],
  }
}

function createEmptyDraft(workspaceId: string): AutomationTaskDraft {
  return {
    name: 'PRD 初稿生成',
    description: '根据需求文档，生成产品需求文档初稿',
    prompt: TEMPLATE_TASKS[0].prompt,
    workspaceId,
    model: 'GPT-5.1',
    runModes: ['manual', 'chat'],
    toolResourceIds: ['file', 'knowledge', 'prd'],
  }
}

function scheduleForDraft(draft: AutomationTaskDraft, existingJob?: AutomationJob): AutomationSchedule {
  if (!draft.runModes.includes('schedule')) {
    return { type: 'manual' }
  }
  if (existingJob?.schedule && existingJob.schedule.type !== 'manual') {
    return existingJob.schedule
  }
  return { type: 'cron', cronExpr: '0 9 * * *' }
}

function deriveRunModes(job: AutomationJob): AutomationTriggerMode[] {
  if (job.triggerModes && job.triggerModes.length > 0) return job.triggerModes
  return job.schedule.type === 'manual' ? ['manual'] : ['manual', 'schedule']
}

function sanitizeResourceIds(ids: string[] | undefined): ResourceId[] {
  const allowed = new Set(RESOURCE_OPTIONS.map((item) => item.id))
  const result = (ids ?? []).filter((id): id is ResourceId => allowed.has(id as ResourceId))
  return result.length > 0 ? result : ['file', 'code']
}

function deriveTags(job: AutomationJob): string[] {
  if (job.systemAction) return ['系统', '自动执行']
  if (job.schedule.type === 'manual') return ['产品', '文档生成']
  return ['定时', '自动化']
}

function summarizePrompt(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, ' ').trim()
  return normalized.length > 26 ? `${normalized.slice(0, 26)}...` : normalized
}

function isDraftValid(draft: AutomationTaskDraft): boolean {
  return draft.name.trim().length > 0
    && draft.description.trim().length > 0
    && draft.prompt.trim().length > 0
    && draft.runModes.length > 0
    && draft.toolResourceIds.length > 0
}

function upsertAutomationJob(jobs: AutomationJob[], job: AutomationJob): AutomationJob[] {
  const next = jobs.some((item) => item.id === job.id)
    ? jobs.map((item) => (item.id === job.id ? job : item))
    : [job, ...jobs]
  return next.sort((left, right) => right.updatedAt - left.updatedAt)
}

function toggleListValue<T extends string>(items: T[], value: T, fallback: T): T[] {
  if (items.includes(value)) {
    const next = items.filter((item) => item !== value)
    return next.length > 0 ? next : [fallback]
  }
  return [...items, value]
}

function statusText(status: AutomationRun['status']): string {
  if (status === 'success') return '成功'
  if (status === 'failed') return '失败'
  return '跳过'
}

function formatRunTime(timestamp: number): string {
  const date = new Date(timestamp)
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startOfYesterday = startOfToday - 86_400_000
  const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })

  if (timestamp >= startOfToday) return `今天 ${time}`
  if (timestamp >= startOfYesterday) return `昨天 ${time}`
  return date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
}
