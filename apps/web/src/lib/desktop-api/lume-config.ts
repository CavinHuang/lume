import type { LumeConfigAgentDefaultStrategy, LumeEffectiveConfig } from '@lume/shared'
import { sidecarCall } from './system'

export const getEffectiveLumeConfig = (workspaceSlug?: string) =>
  sidecarCall<LumeEffectiveConfig>('lume-config:get-effective', workspaceSlug ? { workspaceSlug } : {})

export const updateAgentModelStrategy = (value: LumeConfigAgentDefaultStrategy, workspaceSlug?: string) =>
  sidecarCall<LumeEffectiveConfig>('lume-config:update-section', {
    source: 'user',
    ...(workspaceSlug ? { workspaceSlug } : {}),
    path: 'models.agent',
    value,
    summary: 'update agent default model strategy',
  })
