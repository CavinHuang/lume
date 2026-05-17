import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import type {
  GetGitHubSkillReviewInput,
  GitHubSkillReviewItem,
  GitHubSkillReviewResult,
  InstallGitHubSkillToWorkspaceInput,
  InstallGitHubSkillToWorkspaceResult,
  SkillMeta
} from "@lume/shared";
import { getWorkspaceSkillsDir } from "../infra/config-paths";
import { saveGitHubInstalledSkillMetadata } from "./skills-market-metadata";

interface GitHubRepoTarget {
  owner: string;
  repo: string;
  ref?: string;
  rootPath: string;
  treeSegments?: string[];
}

interface GitHubRepoMetadata {
  default_branch: string;
}

interface GitHubTreeEntry {
  path: string;
  type: string;
}

interface ResolvedGitHubTarget {
  owner: string;
  repo: string;
  ref: string;
  rootPath: string;
}

interface InspectedGitHubSkill extends GitHubSkillReviewItem {
  filePaths: string[];
}

interface InspectResult {
  review: GitHubSkillReviewResult;
  skills: InspectedGitHubSkill[];
}

function parseSkillFrontmatter(content: string, slug: string): SkillMeta {
  const meta: SkillMeta = { slug, name: slug };
  const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) return meta;

  const frontmatter = frontmatterMatch[1] ?? "";
  for (const line of frontmatter.split("\n")) {
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;
    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim().replace(/^["']|["']$/g, "");
    if (key === "name" && value) meta.name = value;
    if (key === "description" && value) meta.description = value;
    if (key === "version" && value) meta.version = value;
  }

  return meta;
}

function parseGitHubUrl(input: string): GitHubRepoTarget {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("GitHub URL 非法");
  }

  if (url.protocol !== "https:" || url.hostname !== "github.com") {
    throw new Error("仅支持公开 github.com 仓库");
  }

  const segments = url.pathname.replace(/^\/|\/$/g, "").split("/").filter(Boolean);
  if (segments.length < 2) {
    throw new Error("GitHub URL 缺少 owner/repo");
  }

  const owner = segments[0] ?? "";
  const repo = (segments[1] ?? "").replace(/\.git$/i, "");
  if (!owner || !repo) {
    throw new Error("GitHub URL 缺少 owner/repo");
  }

  if (segments[2] === "tree") {
    const treeSegments = segments.slice(3);
    if (treeSegments.length === 0) {
      throw new Error("GitHub tree URL 缺少 ref");
    }
    // Keep simple parsing for the common case. Ambiguous slash-containing refs
    // are resolved against the GitHub tree API in resolveGitHubTarget.
    return {
      owner,
      repo,
      ref: treeSegments[0],
      rootPath: treeSegments.slice(1).join("/"),
      treeSegments
    };
  }

  return {
    owner,
    repo,
    ref: undefined,
    rootPath: ""
  };
}

async function fetchJson<T>(url: string, fetchImpl: typeof fetch): Promise<T> {
  const response = await fetchImpl(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "Lume-Skills-Market"
    }
  });
  if (!response.ok) {
    throw new Error(`读取 GitHub 信息失败: ${response.status}`);
  }
  return await response.json() as T;
}

async function fetchText(url: string, fetchImpl: typeof fetch): Promise<string> {
  const response = await fetchImpl(url, {
    headers: {
      Accept: "text/plain",
      "User-Agent": "Lume-Skills-Market"
    }
  });
  if (!response.ok) {
    throw new Error(`读取 GitHub 文件失败: ${response.status}`);
  }
  return await response.text();
}

async function resolveRepoMetadata(target: GitHubRepoTarget, fetchImpl: typeof fetch): Promise<GitHubRepoMetadata> {
  return await fetchJson<GitHubRepoMetadata>(
    `https://api.github.com/repos/${target.owner}/${target.repo}`,
    fetchImpl
  );
}

async function tryFetchRepoTree(
  owner: string,
  repo: string,
  ref: string,
  fetchImpl: typeof fetch
): Promise<GitHubTreeEntry[] | null> {
  const response = await fetchImpl(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "Lume-Skills-Market"
      }
    }
  );

  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`读取 GitHub 仓库树失败: ${response.status}`);
  }

  const payload = await response.json() as { tree?: GitHubTreeEntry[] };
  return payload.tree ?? [];
}

async function resolveGitHubTarget(target: GitHubRepoTarget, fetchImpl: typeof fetch): Promise<ResolvedGitHubTarget> {
  const metadata = await resolveRepoMetadata(target, fetchImpl);

  if (!target.treeSegments || target.treeSegments.length === 0) {
    return {
      owner: target.owner,
      repo: target.repo,
      ref: target.ref ?? metadata.default_branch,
      rootPath: target.rootPath
    };
  }

  for (let splitAt = target.treeSegments.length; splitAt >= 1; splitAt -= 1) {
    const ref = target.treeSegments.slice(0, splitAt).join("/");
    const tree = await tryFetchRepoTree(target.owner, target.repo, ref, fetchImpl);
    if (!tree) continue;

    const rootPath = target.treeSegments.slice(splitAt).join("/");
    return {
      owner: target.owner,
      repo: target.repo,
      ref,
      rootPath
    };
  }

  throw new Error("无法解析 GitHub tree URL 的分支或路径");
}

function filterTreeEntries(entries: GitHubTreeEntry[], rootPath: string): GitHubTreeEntry[] {
  if (!rootPath) return entries;
  return entries.filter((entry) => entry.path === rootPath || entry.path.startsWith(`${rootPath}/`));
}

function buildRiskSummary(filePaths: string[]): string[] {
  const risks = ["公开 GitHub 来源默认需要在安装前审查。"];
  if (filePaths.some((path) => path.includes("/scripts/"))) {
    risks.push("检测到 scripts 目录，请在安装前检查脚本内容。");
  }
  return risks;
}

function buildStructuralIssues(tree: GitHubTreeEntry[], skills: InspectedGitHubSkill[]): string[] {
  const issues: string[] = [];
  if (skills.length > 1) {
    issues.push("检测到多个技能目录，安装时会一次导入多个技能。");
  }

  const coveredPrefixes = skills.map((skill) => (skill.path ? `${skill.path}/` : ""));
  const unrelatedFiles = tree.filter((entry) => {
    if (entry.type !== "blob") return false;
    return !skills.some((skill, index) => {
      const prefix = coveredPrefixes[index] ?? "";
      return prefix ? entry.path.startsWith(prefix) : entry.path === "SKILL.md";
    });
  });
  if (unrelatedFiles.length > 0) {
    issues.push("检测到技能目录之外的文件，安装时只会导入识别到的技能目录。");
  }

  return issues;
}

function buildReviewToken(review: Omit<GitHubSkillReviewResult, "reviewToken">): string {
  return createHash("sha256")
    .update(JSON.stringify({
      normalizedUrl: review.normalizedUrl,
      ref: review.ref,
      rootPath: review.rootPath,
      riskSummary: review.riskSummary,
      structuralIssues: review.structuralIssues,
      skills: review.skills.map((skill) => ({
        slug: skill.slug,
        path: skill.path,
        version: skill.version,
        riskSummary: skill.riskSummary
      }))
    }))
    .digest("hex");
}

async function inspectGitHubSkillSource(
  input: GetGitHubSkillReviewInput,
  deps?: { fetchImpl?: typeof fetch }
): Promise<InspectResult> {
  const fetchImpl = deps?.fetchImpl ?? fetch;
  const parsed = parseGitHubUrl(input.url);
  const target = await resolveGitHubTarget(parsed, fetchImpl);
  const tree = filterTreeEntries(
    (await tryFetchRepoTree(target.owner, target.repo, target.ref, fetchImpl)) ?? [],
    target.rootPath
  );

  const skillPaths = tree
    .filter((entry) => entry.type === "blob" && entry.path.endsWith("SKILL.md"))
    .map((entry) => posix.dirname(entry.path));

  if (skillPaths.length === 0) {
    throw new Error("没有检测到有效的 SKILL.md 或技能目录");
  }

  const skills: InspectedGitHubSkill[] = [];
  for (const skillPath of [...new Set(skillPaths)]) {
    const filePaths = tree
      .filter((entry) => entry.type === "blob" && (entry.path === skillPath || entry.path.startsWith(`${skillPath}/`)))
      .map((entry) => entry.path);

    const skillMdPath = skillPath ? `${skillPath}/SKILL.md` : "SKILL.md";
    const skillMd = await fetchText(
      `https://raw.githubusercontent.com/${target.owner}/${target.repo}/${target.ref}/${skillMdPath}`,
      fetchImpl
    );
    const slug = skillPath ? posix.basename(skillPath) : target.repo;
    const meta = parseSkillFrontmatter(skillMd, slug);

    skills.push({
      slug,
      name: meta.name,
      path: skillPath,
      description: meta.description,
      version: meta.version,
      riskSummary: buildRiskSummary(filePaths),
      filePaths
    });
  }

  const reviewBase = {
    url: input.url,
    normalizedUrl: `https://github.com/${target.owner}/${target.repo}${target.rootPath ? `/tree/${target.ref}/${target.rootPath}` : ""}`,
    owner: target.owner,
    repo: target.repo,
    ref: target.ref,
    rootPath: target.rootPath,
    trustLevel: "review-required" as const,
    riskSummary: buildRiskSummary(skills.flatMap((skill) => skill.filePaths)),
    structuralIssues: buildStructuralIssues(tree, skills),
    skills: skills.map(({ filePaths, ...reviewItem }) => reviewItem)
  };

  return {
    review: {
      ...reviewBase,
      reviewToken: buildReviewToken(reviewBase)
    },
    skills
  };
}

async function fetchSkillFileContents(
  inspected: InspectResult,
  fetchImpl: typeof fetch
): Promise<Map<string, Array<{ relativePath: string; content: string }>>> {
  const filesBySkill = new Map<string, Array<{ relativePath: string; content: string }>>();

  for (const skill of inspected.skills) {
    const skillFiles: Array<{ relativePath: string; content: string }> = [];
    for (const filePath of skill.filePaths) {
      const prefix = skill.path ? `${skill.path}/` : "";
      const relativePath = prefix && filePath.startsWith(prefix) ? filePath.slice(prefix.length) : filePath;
      const content = await fetchText(
        `https://raw.githubusercontent.com/${inspected.review.owner}/${inspected.review.repo}/${inspected.review.ref}/${filePath}`,
        fetchImpl
      );
      skillFiles.push({ relativePath, content });
    }
    filesBySkill.set(skill.slug, skillFiles);
  }

  return filesBySkill;
}

export async function getGitHubSkillReview(
  input: GetGitHubSkillReviewInput,
  deps?: { fetchImpl?: typeof fetch }
): Promise<GitHubSkillReviewResult> {
  return (await inspectGitHubSkillSource(input, deps)).review;
}

export async function installGitHubSkillToWorkspace(
  input: InstallGitHubSkillToWorkspaceInput,
  deps?: { fetchImpl?: typeof fetch }
): Promise<InstallGitHubSkillToWorkspaceResult> {
  const fetchImpl = deps?.fetchImpl ?? fetch;
  const inspected = await inspectGitHubSkillSource({ url: input.url }, { fetchImpl });
  if (input.reviewToken !== inspected.review.reviewToken) {
    throw new Error("请先完成安装前审查并确认风险摘要");
  }

  const skillsDir = getWorkspaceSkillsDir(input.workspaceSlug);
  for (const skill of inspected.skills) {
    const targetDir = join(skillsDir, skill.slug);
    if (!input.overwrite && existsSync(join(targetDir, "SKILL.md"))) {
      return {
        ok: true,
        imported: false,
        reason: `技能「${skill.slug}」已存在`
      };
    }
  }

  const filesBySkill = await fetchSkillFileContents(inspected, fetchImpl);
  const stagedDirs = new Map<string, string>();

  try {
    for (const skill of inspected.skills) {
      const stageDir = join(skillsDir, `.tmp-${skill.slug}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
      rmSync(stageDir, { recursive: true, force: true });
      mkdirSync(stageDir, { recursive: true });

      for (const file of filesBySkill.get(skill.slug) ?? []) {
        const destination = join(stageDir, file.relativePath);
        mkdirSync(dirname(destination), { recursive: true });
        writeFileSync(destination, file.content, "utf-8");
      }

      stagedDirs.set(skill.slug, stageDir);
    }

    for (const skill of inspected.skills) {
      const stageDir = stagedDirs.get(skill.slug);
      if (!stageDir) continue;
      const targetDir = join(skillsDir, skill.slug);
      rmSync(targetDir, { recursive: true, force: true });
      renameSync(stageDir, targetDir);
    }
  } catch (error) {
    for (const stageDir of stagedDirs.values()) {
      rmSync(stageDir, { recursive: true, force: true });
    }
    throw error;
  }

  saveGitHubInstalledSkillMetadata({
    workspaceSlug: input.workspaceSlug,
    slugs: inspected.skills.map((skill) => skill.slug),
    sourceRef: inspected.review.normalizedUrl,
    ref: inspected.review.ref,
    rootPath: inspected.review.rootPath
  });

  return {
    ok: true,
    imported: true
  };
}

export const __internal = {
  parseGitHubUrl,
  parseSkillFrontmatter,
  buildRiskSummary,
  inspectGitHubSkillSource
};
