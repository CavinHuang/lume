import { atomWithStorage } from 'jotai/utils'
import type { ThreadRightPanelWorkspace } from '@/components/right-panel/right-panel-state'

export type RightPanelDisplayMode = 'normal' | 'expanded' | 'compact'

export interface RightPanelLayoutState {
  open: boolean
  mode: RightPanelDisplayMode
}

export const rightPanelWorkspacesAtom = atomWithStorage<Record<string, ThreadRightPanelWorkspace>>(
  'right-panel-workspaces',
  {},
)

export const rightPanelLayoutAtom = atomWithStorage<RightPanelLayoutState>(
  'right-panel-layout',
  { open: true, mode: 'normal' },
)
