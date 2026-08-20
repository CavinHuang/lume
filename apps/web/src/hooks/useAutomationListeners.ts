import { listAutomationJobs, listAutomationRuns } from '@/lib/desktop-api/automation'
import { useEffect } from 'react'
import { useSetAtom } from 'jotai'
import { listen } from '@/lib/desktop-runtime/event'
import type { AutomationRun } from '@lume/shared'
import { automationJobsAtom, automationRunsAtom } from '@/atoms'

export function useAutomationListeners() {
  const setJobs = useSetAtom(automationJobsAtom)
  const setRuns = useSetAtom(automationRunsAtom)

  useEffect(() => {
    let cancelled = false

    const loadData = async () => {
      try {
        const [jobs, runs] = await Promise.all([
          listAutomationJobs(),
          listAutomationRuns({ limit: 50 }),
        ])
        if (!cancelled) {
          setJobs(jobs)
          setRuns(runs)
        }
      } catch (error) {
        console.error('[自动化] 加载数据失败:', error)
      }
    }

    loadData()

    const unlisten = listen<{ method: string; params: { run: AutomationRun } }>('sidecar:event', (event) => {
      if (event.payload.method === 'automation:run-completed') {
        void loadData()
      }
    })

    return () => {
      cancelled = true
      unlisten.then(fn => fn())
    }
  }, [setJobs, setRuns])
}
