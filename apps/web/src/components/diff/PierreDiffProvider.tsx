import { useMemo, type ReactNode } from 'react'
import { WorkerPoolContextProvider } from '@pierre/diffs/react'
import diffWorkerUrl from '@pierre/diffs/worker/worker.js?url'
import { registerLumeDiffThemes } from './pierre-theme'

registerLumeDiffThemes()

export function PierreDiffProvider({ children }: { children: ReactNode }) {
  const poolOptions = useMemo(() => ({
    poolSize: Math.min(4, Math.max(1, typeof navigator === 'undefined' ? 1 : navigator.hardwareConcurrency || 2)),
    workerFactory: () => new Worker(diffWorkerUrl, { type: 'module' }),
  }), [])

  return (
    <WorkerPoolContextProvider
      poolOptions={poolOptions}
      highlighterOptions={{ preferredHighlighter: 'shiki-js' }}
    >
      {children}
    </WorkerPoolContextProvider>
  )
}

