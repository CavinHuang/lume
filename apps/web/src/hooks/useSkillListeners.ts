import { useEffect } from 'react'
import { toast } from 'sonner'
import { onSidecarEvent } from '@/lib/desktop-api'
import { buildSkillImprovementSuggestionToast } from './skill-listeners-state'

export function useSkillListeners() {
  useEffect(() => {
    const unlisten = onSidecarEvent((method, params) => {
      const nextToast = buildSkillImprovementSuggestionToast(method, params)
      if (!nextToast) return
      toast.success(nextToast.message)
    })

    return () => {
      unlisten.then((fn) => fn())
    }
  }, [])
}
