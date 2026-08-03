import { useMemo, type ReactNode } from 'react'
import { EditProvider, WorkerPoolContextProvider } from '@pierre/diffs/react'
import { Editor, type EditorOptions } from '@pierre/diffs/edit'
import diffWorkerUrl from '@pierre/diffs/worker/worker.js?url'
import { readClipboardText } from '@/lib/desktop-api'
import { LUME_DIFF_THEMES, registerLumeDiffThemes } from './pierre-theme'

registerLumeDiffThemes()

export function PierreDiffProvider({ children }: { children: ReactNode }) {
  const poolOptions = useMemo(() => ({
    poolSize: Math.min(4, Math.max(1, typeof navigator === 'undefined' ? 1 : navigator.hardwareConcurrency || 2)),
    workerFactory: () => new Worker(diffWorkerUrl, { type: 'module' }),
  }), [])
  const createEditor = useMemo(() => (
    <TAnnotation,>(options: EditorOptions<TAnnotation>) => new Editor<TAnnotation>({
      persistState: true,
      persistStateStorage: 'indexedDB',
      matchBrackets: true,
      autoSurround: 'default',
      clipboard: { readText: () => readClipboardText() },
      ...options,
    })
  ), [])

  return (
    <WorkerPoolContextProvider
      poolOptions={poolOptions}
      highlighterOptions={{
        preferredHighlighter: 'shiki-js',
        theme: LUME_DIFF_THEMES,
      }}
    >
      <EditProvider createEditor={createEditor}>
        {children}
      </EditProvider>
    </WorkerPoolContextProvider>
  )
}
