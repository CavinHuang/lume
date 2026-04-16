import type { GitHubRelease, GitHubReleaseListOptions } from "@lume/shared";

const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_REPO_OWNER = process.env.LUME_GITHUB_RELEASE_OWNER?.trim() || "CavinHUang";
const GITHUB_REPO_NAME = process.env.LUME_GITHUB_RELEASE_REPO?.trim() || "Lume";
const CACHE_TTL_MS = 5 * 60 * 1000;

interface ReleaseCache {
  data: GitHubRelease[];
  timestamp: number;
}

let releaseCache: ReleaseCache | null = null;

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function filterReleases(releases: GitHubRelease[], includePrerelease: boolean): GitHubRelease[] {
  if (includePrerelease) {
    return releases;
  }
  return releases.filter((release) => !release.prerelease && !release.draft);
}

async function fetchFromGitHub<T>(endpoint: string): Promise<T> {
  const url = `${GITHUB_API_BASE}/repos/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}${endpoint}`;
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "Lume-Sidecar"
    }
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`GitHub API 请求失败: ${response.status} ${response.statusText} ${message}`);
  }

  return (await response.json()) as T;
}

export async function getLatestGitHubRelease(): Promise<GitHubRelease | null> {
  try {
    return await fetchFromGitHub<GitHubRelease>("/releases/latest");
  } catch (error) {
    console.warn("[github-release] 获取最新版本失败:", getErrorMessage(error));
    return null;
  }
}

export async function listGitHubReleases(
  options: GitHubReleaseListOptions = {}
): Promise<GitHubRelease[]> {
  const perPage = options.perPage ?? 10;
  const page = options.page ?? 1;
  const includePrerelease = options.includePrerelease ?? false;

  try {
    if (releaseCache && page === 1 && Date.now() - releaseCache.timestamp < CACHE_TTL_MS) {
      return filterReleases(releaseCache.data, includePrerelease).slice(0, perPage);
    }

    const params = new URLSearchParams({
      per_page: String(perPage),
      page: String(page)
    });

    const releases = await fetchFromGitHub<GitHubRelease[]>(`/releases?${params.toString()}`);
    if (page === 1) {
      releaseCache = {
        data: releases,
        timestamp: Date.now()
      };
    }

    return filterReleases(releases, includePrerelease);
  } catch (error) {
    console.warn("[github-release] 获取版本历史失败:", getErrorMessage(error));
    if (!releaseCache) {
      return [];
    }
    return filterReleases(releaseCache.data, includePrerelease).slice(0, perPage);
  }
}

export async function getGitHubReleaseByTag(tag: string): Promise<GitHubRelease | null> {
  try {
    return await fetchFromGitHub<GitHubRelease>(`/releases/tags/${encodeURIComponent(tag)}`);
  } catch (error) {
    console.warn(`[github-release] 获取版本 ${tag} 失败:`, getErrorMessage(error));
    return null;
  }
}

export function clearGitHubReleaseCache(): void {
  releaseCache = null;
}
