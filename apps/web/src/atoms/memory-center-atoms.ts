import { atom } from 'jotai'
import type { MemoryCenterDeepLink } from '@/components/memory/memory-center-state'
import { DEFAULT_MEMORY_CENTER_LINK } from '@/components/memory/memory-center-state'

export const memoryCenterDeepLinkAtom = atom<MemoryCenterDeepLink>(DEFAULT_MEMORY_CENTER_LINK)
export const memoryCenterVersionAtom = atom(0)
