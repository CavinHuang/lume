import type { GitHubRelease } from "@lume/shared";
import { createLogger } from "../infra/logger";

const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_REPO_OWNER = process.env.LUME_GITHUB_RELEASE_OWNER?.trim() || "CavinHUang";
const GITHUB_REPO_NAME = process.env.LUME_GITHUB_RELEASE_REPO?.trim() || "Lume";
const log = createLogger("github-release");

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
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
    throw new Error(`GitHub API 请求失败: ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as T;
}

export async function getLatestGitHubRelease(): Promise<GitHubRelease | null> {
  try {
    return await fetchFromGitHub<GitHubRelease>("/releases/latest");
  } catch (error) {
    log.warn("failed to fetch latest release", { error: getErrorMessage(error) });
    return null;
  }
}
