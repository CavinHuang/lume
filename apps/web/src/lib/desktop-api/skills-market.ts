import type {
  GetGitHubSkillReviewInput,
  GetSkillMarketDetailInput,
  GitHubSkillReviewResult,
  GlobalImportResult,
  ImportLocalSkillDirectoryToWorkspaceInput,
  InstallSkillMarketItemToWorkspaceInput,
  InstallGitHubSkillToWorkspaceInput,
  InstallGitHubSkillToWorkspaceResult,
  SkillMarketCatalogResult,
  SkillMarketDetailResult,
} from '@lume/shared'
import { sidecarCall } from './system'

export const getSkillMarketCatalog = (workspaceSlug: string, includeBlockedSources = false) =>
  sidecarCall<SkillMarketCatalogResult>('agent:get-skill-market-catalog', {
    workspaceSlug,
    includeBlockedSources,
  })

export const getSkillMarketDetail = (input: GetSkillMarketDetailInput) =>
  sidecarCall<SkillMarketDetailResult>('agent:get-skill-market-detail', input)

export const getGitHubSkillReview = (input: GetGitHubSkillReviewInput) =>
  sidecarCall<GitHubSkillReviewResult>('agent:get-github-skill-review', input)

export const installGitHubSkillToWorkspace = (input: InstallGitHubSkillToWorkspaceInput) =>
  sidecarCall<InstallGitHubSkillToWorkspaceResult>('agent:install-github-skill-to-workspace', input)

export const importLocalSkillDirectoryToWorkspace = (input: ImportLocalSkillDirectoryToWorkspaceInput) =>
  sidecarCall<GlobalImportResult>('agent:import-local-skill-directory-to-workspace', input)

export const installSkillMarketItemToWorkspace = (input: InstallSkillMarketItemToWorkspaceInput) =>
  sidecarCall<GlobalImportResult>('agent:install-skill-market-item-to-workspace', input)

export const deleteWorkspaceSkill = (workspaceSlug: string, skillSlug: string) =>
  sidecarCall<{ ok: true }>('agent:delete-skill', { workspaceSlug, skillSlug })
