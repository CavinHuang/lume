import { useEffect } from 'react'
import { useSetAtom } from 'jotai'
import { toast } from 'sonner'
import { pendingSkillImprovementSuggestionsAtom } from '@/atoms'
import { onSidecarEvent } from '@/lib/desktop-api'
import {
  buildSkillImprovementSuggestionToast,
  extractSkillImprovementSuggestions,
  mergeSkillImprovementSuggestions,
} from './skill-listeners-state'

export function useSkillListeners() {
  const setPendingSkillImprovementSuggestions = useSetAtom(pendingSkillImprovementSuggestionsAtom)

  useEffect(() => {
    const unlisten = onSidecarEvent((method, params) => {
      const suggestions = extractSkillImprovementSuggestions(method, params)
      if (suggestions.length > 0) {
        setPendingSkillImprovementSuggestions((current) => mergeSkillImprovementSuggestions(current, suggestions))
      }
      const nextToast = buildSkillImprovementSuggestionToast(method, params)
      if (!nextToast) return
      toast.success(nextToast.message)
    })

    return () => {
      unlisten.then((fn) => fn())
    }
  }, [setPendingSkillImprovementSuggestions])
}
