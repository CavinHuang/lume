import { atom } from 'jotai'
import type { PendingSkillImprovementSuggestion } from '@/hooks/skill-listeners-state'

export const pendingSkillImprovementSuggestionsAtom = atom<PendingSkillImprovementSuggestion[]>([])
