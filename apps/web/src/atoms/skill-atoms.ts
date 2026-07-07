import { atom } from 'jotai'
import type { PendingSkillImprovementSuggestion } from '@/hooks/skill-listeners-state'
import type { PluginMarketItem } from '@lume/shared'

export const pendingSkillImprovementSuggestionsAtom = atom<PendingSkillImprovementSuggestion[]>([])

export const bridgeWizardOpenAtom = atom(false)
export const bridgeWizardPluginAtom = atom<PluginMarketItem | null>(null)
