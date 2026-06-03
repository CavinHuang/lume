import { useEffect } from 'react'
import { toast } from 'sonner'
import { onSidecarEvent } from '@/lib/desktop-api'
import { buildReadingGenerationToast } from './reading-listeners-state'

export function useReadingListeners() {
  useEffect(() => {
    const unlisten = onSidecarEvent((method, params) => {
      const nextToast = buildReadingGenerationToast(method, params)
      if (!nextToast) return
      if (nextToast.kind === 'success') {
        toast.success(nextToast.message)
      } else {
        toast.error(nextToast.message)
      }
    })

    return () => {
      unlisten.then((fn) => fn())
    }
  }, [])
}
