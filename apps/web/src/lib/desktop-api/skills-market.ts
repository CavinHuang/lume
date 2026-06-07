import type {
  AnalyzeSkillImprovementInput,
  ApplySkillImprovementInput,
  EditableSkillDetailResult,
  EditableSkillMeta,
  GetEditableSkillInput,
  GetGitHubSkillReviewInput,
  GetSkillMarketDetailInput,
  GitHubSkillReviewResult,
  GlobalImportResult,
  ImportLocalSkillDirectoryToWorkspaceInput,
  InstallSkillMarketItemToWorkspaceInput,
  InstallGitHubSkillToWorkspaceInput,
  InstallGitHubSkillToWorkspaceResult,
  ListSkillVersionsInput,
  RestoreSkillVersionInput,
  SaveWorkspaceSkillInput,
  SaveWorkspaceSkillResult,
  SkillEvolutionResult,
  SkillImprovementAnalysisResult,
  SkillMarketCatalogResult,
  SkillMarketDetailResult,
  SkillMeta,
  SkillStorageScope,
  SkillVersionInfo,
} from '@lume/shared'
import { AGENT_IPC_CHANNELS as AGENT_CHANNELS } from '@lume/shared'
import { sidecarCall } from './system'

export const getSkillMarketCatalog = (workspaceSlug: string, includeBlockedSources = false) =>
  sidecarCall<SkillMarketCatalogResult>('agent:get-skill-market-catalog', {
    workspaceSlug,
    includeBlockedSources,
  })

export const getSkillMarketDetail = (input: GetSkillMarketDetailInput) =>
  sidecarCall<SkillMarketDetailResult>('agent:get-skill-market-detail', input)

export const getWorkspaceSkills = (workspaceSlug: string) =>
  sidecarCall<SkillMeta[]>(AGENT_CHANNELS.GET_SKILLS, { workspaceSlug })

export const getAgentThreadPath = (threadId: string, workspaceSlug?: string) =>
  sidecarCall<string>(AGENT_CHANNELS.GET_THREAD_PATH, {
    threadId,
    ...(workspaceSlug ? { workspaceSlug } : {}),
  })

export const listEditableSkills = (workspaceSlug: string, cwd?: string) =>
  sidecarCall<EditableSkillMeta[]>(AGENT_CHANNELS.LIST_EDITABLE_SKILLS, {
    workspaceSlug,
    ...(cwd ? { cwd } : {}),
  })

export const getEditableSkill = (input: GetEditableSkillInput) =>
  sidecarCall<EditableSkillDetailResult>(AGENT_CHANNELS.GET_EDITABLE_SKILL, input)

export const saveWorkspaceSkill = (input: SaveWorkspaceSkillInput) =>
  sidecarCall<SaveWorkspaceSkillResult>(AGENT_CHANNELS.SAVE_SKILL, input)

export const listSkillVersions = (input: ListSkillVersionsInput) =>
  sidecarCall<SkillVersionInfo[]>('agent:list-skill-versions', input)

export const restoreSkillVersion = (input: RestoreSkillVersionInput) =>
  sidecarCall<SkillEvolutionResult>('agent:restore-skill-version', input)

export const analyzeSkillImprovement = (input: AnalyzeSkillImprovementInput) =>
  sidecarCall<SkillImprovementAnalysisResult>('agent:analyze-skill-improvement', input)

export const applySkillImprovement = (input: ApplySkillImprovementInput) =>
  sidecarCall<SkillEvolutionResult>('agent:apply-skill-improvement', input)

export const getGitHubSkillReview = (input: GetGitHubSkillReviewInput) =>
  sidecarCall<GitHubSkillReviewResult>('agent:get-github-skill-review', input)

export const installGitHubSkillToWorkspace = (input: InstallGitHubSkillToWorkspaceInput) =>
  sidecarCall<InstallGitHubSkillToWorkspaceResult>('agent:install-github-skill-to-workspace', input)

export const importLocalSkillDirectoryToWorkspace = (input: ImportLocalSkillDirectoryToWorkspaceInput) =>
  sidecarCall<GlobalImportResult>('agent:import-local-skill-directory-to-workspace', input)

export const installSkillMarketItemToWorkspace = (input: InstallSkillMarketItemToWorkspaceInput) =>
  sidecarCall<GlobalImportResult>('agent:install-skill-market-item-to-workspace', input)

export const deleteWorkspaceSkill = (
  workspaceSlug: string,
  skillSlug: string,
  storageScope?: SkillStorageScope,
  cwd?: string,
) =>
  sidecarCall<{ ok: true }>('agent:delete-skill', {
    workspaceSlug,
    skillSlug,
    ...(storageScope ? { storageScope } : {}),
    ...(cwd ? { cwd } : {}),
  })
