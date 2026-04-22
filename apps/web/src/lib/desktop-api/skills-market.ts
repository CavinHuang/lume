import type {
  GetGitHubSkillReviewInput,
  GitHubSkillReviewResult,
  InstallGitHubSkillToWorkspaceInput,
  InstallGitHubSkillToWorkspaceResult,
  SkillMarketCatalogResult,
} from '@lume/shared'
import { sidecarCall } from './system'

export const getSkillMarketCatalog = (workspaceSlug: string, includeBlockedSources = false) =>
  sidecarCall<SkillMarketCatalogResult>('agent:get-skill-market-catalog', {
    workspaceSlug,
    includeBlockedSources,
  })

export const getGitHubSkillReview = (input: GetGitHubSkillReviewInput) =>
  sidecarCall<GitHubSkillReviewResult>('agent:get-github-skill-review', input)

export const installGitHubSkillToWorkspace = (input: InstallGitHubSkillToWorkspaceInput) =>
  sidecarCall<InstallGitHubSkillToWorkspaceResult>('agent:install-github-skill-to-workspace', input)
