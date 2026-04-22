import { atom } from 'jotai'
import type { AutomationJob, AutomationRun } from '@lume/shared'

export const automationJobsAtom = atom<AutomationJob[]>([])
export const automationRunsAtom = atom<AutomationRun[]>([])
export const automationLoadingAtom = atom(false)
