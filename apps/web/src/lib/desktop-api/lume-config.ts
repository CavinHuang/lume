import type {
  LumeConfigAgentDefaultStrategy,
  LumeConfigPermissionApprovalRoutes,
  LumeConfigPermissionMode,
  LumeConfigPermissionsSection,
  LumeConfigPluginsSection,
  LumeConfigSimpleModelStrategy,
  LumeConfigRoutineModelStrategy,
  LumeConfigSkillsSection,
  LumeConfigThinkingLevel,
  LumeConfigSubagentModelStrategy,
  LumeConfigWebSearchSection,
  LumeEffectiveConfig,
} from '@lume/shared'
import { sidecarCall } from './system'

export const getEffectiveLumeConfig = (workspaceSlug?: string) =>
  sidecarCall<LumeEffectiveConfig>('lume-config:get-effective', workspaceSlug ? { workspaceSlug } : {})

export const getLumeConfigSourcePath = () =>
  sidecarCall<{ sourcePath: string }>('lume-config:get-source-path', {})

export const openLumeConfigSourceFile = () =>
  sidecarCall<{ ok: boolean }>('lume-config:open-source-file', {})

export const updateAgentModelStrategy = (value: LumeConfigAgentDefaultStrategy, workspaceSlug?: string) =>
  sidecarCall<LumeEffectiveConfig>('lume-config:update-section', {
    source: 'user',
    ...(workspaceSlug ? { workspaceSlug } : {}),
    path: 'models.agent',
    value,
    summary: 'update agent default model strategy',
  })

export const updateSubagentModelStrategy = (value: LumeConfigSubagentModelStrategy, workspaceSlug?: string) =>
  sidecarCall<LumeEffectiveConfig>('lume-config:update-section', {
    source: 'user',
    ...(workspaceSlug ? { workspaceSlug } : {}),
    path: 'models.subagent',
    value,
    summary: 'update subagent default model strategy',
  })

export const updateRoutineModelStrategy = (value: LumeConfigRoutineModelStrategy, workspaceSlug?: string) =>
  sidecarCall<LumeEffectiveConfig>('lume-config:update-section', {
    source: 'user',
    ...(workspaceSlug ? { workspaceSlug } : {}),
    path: 'models.routine',
    value,
    summary: 'update routine scheduling model strategy',
  })

export type LumeModelPurpose =
  | 'background'
  | 'contextCompression'
  | 'title'
  | 'welcomeSuggestions'
  | 'permissionClassifier'
  | 'memoryJudgement'

export const updateModelPurposeStrategy = (
  purpose: LumeModelPurpose,
  value: LumeConfigSimpleModelStrategy,
  workspaceSlug?: string
) =>
  sidecarCall<LumeEffectiveConfig>('lume-config:update-section', {
    source: 'user',
    ...(workspaceSlug ? { workspaceSlug } : {}),
    path: `models.${purpose}`,
    value,
    summary: `update ${purpose} model strategy`,
  })

export const updateImageGenerationModelStrategy = (
  value: { priorityModelRefs?: string[] },
  workspaceSlug?: string
) =>
  sidecarCall<LumeEffectiveConfig>('lume-config:update-section', {
    source: 'user',
    ...(workspaceSlug ? { workspaceSlug } : {}),
    path: 'models.imageGeneration',
    value,
    summary: 'update image generation model strategy',
  })

export const updateModelContextWindows = (
  value: Record<string, number>,
  workspaceSlug?: string
) =>
  sidecarCall<LumeEffectiveConfig>('lume-config:update-section', {
    source: 'user',
    ...(workspaceSlug ? { workspaceSlug } : {}),
    path: 'models.contextWindows',
    value,
    summary: 'update model context windows',
  })

export const updateEmbeddingModelRef = (modelRef: string, workspaceSlug?: string) =>
  sidecarCall<LumeEffectiveConfig>('lume-config:update-section', {
    source: 'user',
    ...(workspaceSlug ? { workspaceSlug } : {}),
    path: 'models.embedding.defaultModelRef',
    value: modelRef,
    summary: 'update memory embedding model',
  })

export const updateMemoryExtractionModelRef = (modelRef: string | undefined, workspaceSlug?: string) =>
  sidecarCall<LumeEffectiveConfig>('lume-config:update-section', {
    source: 'user',
    ...(workspaceSlug ? { workspaceSlug } : {}),
    path: 'memory.extraction.modelRef',
    value: modelRef ?? null,
    summary: modelRef ? 'update memory extraction model' : 'clear memory extraction model',
  })

export const updateAgentThinkingLevel = (value: LumeConfigThinkingLevel, workspaceSlug?: string) =>
  sidecarCall<LumeEffectiveConfig>('lume-config:update-section', {
    source: 'user',
    ...(workspaceSlug ? { workspaceSlug } : {}),
    path: 'agent.thinkingLevel',
    value,
    summary: 'update agent thinking level',
  })

export const updateAgentPermissionMode = (value: LumeConfigPermissionMode, workspaceSlug?: string) =>
  sidecarCall<LumeEffectiveConfig>('lume-config:update-section', {
    source: 'user',
    ...(workspaceSlug ? { workspaceSlug } : {}),
    path: 'agent.permissionMode',
    value,
    summary: 'update agent permission mode',
  })

export const updatePermissionsSection = (value: LumeConfigPermissionsSection, workspaceSlug?: string) =>
  sidecarCall<LumeEffectiveConfig>('lume-config:update-section', {
    source: 'user',
    ...(workspaceSlug ? { workspaceSlug } : {}),
    path: 'permissions',
    value,
    summary: 'update permission settings',
  })

export const updateSkillsConfig = (value: LumeConfigSkillsSection, workspaceSlug?: string) =>
  sidecarCall<LumeEffectiveConfig>('lume-config:update-section', {
    source: 'user',
    ...(workspaceSlug ? { workspaceSlug } : {}),
    path: 'skills',
    value,
    summary: 'update workspace skills settings',
  })

export const updatePluginsConfig = (value: LumeConfigPluginsSection, workspaceSlug?: string) =>
  sidecarCall<LumeEffectiveConfig>('lume-config:update-section', {
    source: 'user',
    ...(workspaceSlug ? { workspaceSlug } : {}),
    path: 'plugins',
    value,
    summary: 'update plugin market settings',
  })

export const updatePermissionApprovals = (value: LumeConfigPermissionApprovalRoutes, workspaceSlug?: string) =>
  sidecarCall<LumeEffectiveConfig>('lume-config:update-section', {
    source: 'user',
    ...(workspaceSlug ? { workspaceSlug } : {}),
    path: 'permissions.approvals',
    value,
    summary: 'update permission approval routes',
  })

export const updateWebSearchConfig = (value: LumeConfigWebSearchSection, workspaceSlug?: string) =>
  sidecarCall<LumeEffectiveConfig>('lume-config:update-section', {
    source: 'user',
    ...(workspaceSlug ? { workspaceSlug } : {}),
    path: 'webSearch',
    value,
    summary: 'update web search settings',
  })
