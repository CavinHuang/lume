import type { Tab } from '@/atoms'
import type { AutomationRun } from '@lume/shared'
import { upsertTab } from '@/components/tabs/file-tabs'

/** 把时间戳格式化为 MM-DD HH:mm（本地时区）。 */
export function formatRunTime(timestamp: number): string {
  const date = new Date(timestamp)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 根据一次自动化运行构造只读回放 tab；运行无 threadId 时返回 null。 */
export function buildAutomationRunReplayTab(run: AutomationRun): Tab | null {
  if (!run.threadId) return null
  return {
    id: run.threadId,
    type: 'agent',
    title: `自动化·${run.jobName} · ${formatRunTime(run.startedAt)}`,
    threadId: run.threadId,
    readOnly: true,
  }
}

/** 把运行记录的只读回放 tab 应用到当前 tabs：返回新的 tabs 与应激活的 tabId；无可回放会话时返回 null。 */
export function openAutomationRunReplay(
  run: AutomationRun,
  tabs: Tab[],
): { tabs: Tab[]; activeTabId: string } | null {
  const tab = buildAutomationRunReplayTab(run)
  if (!tab) return null
  return { tabs: upsertTab(tabs, tab), activeTabId: tab.id }
}

/** 打开自动化管理 tab 并预选某个任务详情：返回应写入的 tabs、激活的 tabId 与要预选的 jobId。 */
export function openAutomationJobDetail(
  jobId: string,
  tabs: Tab[],
): { tabs: Tab[]; activeTabId: string; selectedJobId: string } {
  const automationTab: Tab = { id: '__automation__', type: 'automation', title: '自动化' }
  return {
    tabs: upsertTab(tabs, automationTab),
    activeTabId: '__automation__',
    selectedJobId: jobId,
  }
}
