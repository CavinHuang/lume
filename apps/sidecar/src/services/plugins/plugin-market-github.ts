/**
 * GitHub 适配层(#177 自 plugin-market-service.ts 下沉,纯移动):
 * 仓库树/manifest/raw 文件读取、commit 解析(git fallback)与 tarball 落盘,
 * 经 createPluginMarketGitHubAdapter 注入网络原语(requestRemote/fetchText)。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import {
  normalizePluginManifests,
  type NormalizedPlugin,
} from "@lume/agent-sdk";
import type { PluginReadmePreview, PluginSourceRef } from "@lume/shared";
import { PluginMarketError } from "./plugin-market-errors";

const execFileAsync = promisify(execFile);
const GITHUB_ARCHIVE_MAX_BYTES = 512 * 1024 * 1024;
const GITHUB_API_MAX_BYTES = 8 * 1024 * 1024;

export interface GitHubTreeEntry {
  path: string;
  type: string;
}

export interface GitHubRepoRoot {
  owner: string;
  repo: string;
  ref: string;
  rootPath: string;
  url: string;
}

export interface GitHubManifestMatch {
  path: string;
  format: "lume" | "codex" | "legacy";
}

const README_MAX_BYTES = 256 * 1024;
export function truncateReadme(
  markdown: string,
  path: string,
): PluginReadmePreview {
  if (Buffer.byteLength(markdown, "utf-8") <= README_MAX_BYTES) {
    return { markdown, path, truncated: false };
  }
  const buffer = Buffer.from(markdown, "utf-8").subarray(0, README_MAX_BYTES);
  return {
    markdown: buffer.toString("utf-8").replace(/\uFFFD+$/g, ""),
    path,
    truncated: true,
  };
}

export async function resolveGitHubCommitWithGit(
  owner: string,
  repo: string,
  ref?: string,
): Promise<string> {
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new PluginMarketError("source_not_found", "GitHub 仓库标识非法");
  }
  const remote = `https://github.com/${owner}/${repo}.git`;
  const patterns = ref
    ? [ref, `refs/heads/${ref}`, `refs/tags/${ref}`, `refs/tags/${ref}^{}`]
    : ["HEAD"];
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["ls-remote", remote, ...patterns],
      {
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
    );
    const rows = stdout.split(/\r?\n/).flatMap((line) => {
      const match = /^([a-f0-9]{40})\s+(.+)$/i.exec(line.trim());
      return match ? [{ sha: match[1]!.toLowerCase(), name: match[2]! }] : [];
    });
    const preferred = ref
      ? (rows.find((row) => row.name === `refs/tags/${ref}^{}`) ??
        rows.find((row) => row.name === `refs/heads/${ref}`) ??
        rows.find((row) => row.name === `refs/tags/${ref}`) ??
        rows[0])
      : (rows.find((row) => row.name === "HEAD") ?? rows[0]);
    if (preferred) return preferred.sha;
  } catch (error) {
    throw new PluginMarketError(
      "network_failed",
      `无法固定 GitHub 提交: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  throw new PluginMarketError(
    "invalid_manifest",
    "GitHub 快照缺少有效提交 SHA",
  );
}

export function parseGitHubRootUrl(input: string): GitHubRepoRoot {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new PluginMarketError("source_not_found", "GitHub URL 非法");
  }
  if (url.protocol !== "https:" || url.hostname !== "github.com") {
    throw new PluginMarketError(
      "source_not_found",
      "远程市场源仅支持 github.com",
    );
  }
  const segments = url.pathname
    .replace(/^\/|\/$/g, "")
    .split("/")
    .filter(Boolean);
  const owner = segments[0] ?? "";
  const repo = (segments[1] ?? "").replace(/\.git$/i, "");
  if (!owner || !repo) {
    throw new PluginMarketError(
      "source_not_found",
      "GitHub URL 缺少 owner/repo",
    );
  }
  if (segments[2] === "tree") {
    const ref = segments[3];
    if (!ref) {
      throw new PluginMarketError(
        "source_not_found",
        "GitHub tree URL 缺少 ref",
      );
    }
    return {
      owner,
      repo,
      ref,
      rootPath: segments.slice(4).join("/"),
      url: input,
    };
  }
  return { owner, repo, ref: "", rootPath: "", url: input };
}

export function githubTreeUrl(root: GitHubRepoRoot, source: string): string {
  const subdir = joinPosix(root.rootPath, source);
  return `https://github.com/${root.owner}/${root.repo}/tree/${root.ref}${subdir ? `/${subdir}` : ""}`;
}

export function resolveGitHubManifestPath(
  tree: GitHubTreeEntry[],
  subdir?: string,
): GitHubManifestMatch {
  const match = githubManifestCandidates(subdir).find((candidate) =>
    tree.some(
      (entry) => entry.type === "blob" && entry.path === candidate.path,
    ),
  );
  if (!match) {
    throw new PluginMarketError(
      "invalid_manifest",
      "GitHub 仓库中没有检测到 .lume-plugin/plugin.json 或 .codex-plugin/plugin.json",
    );
  }
  return match;
}

export function githubManifestCandidates(
  subdir?: string,
): GitHubManifestMatch[] {
  const prefix = subdir ? `${subdir.replace(/\/$/, "")}/` : "";
  return [
    { path: `${prefix}.lume-plugin/plugin.json`, format: "lume" },
    { path: `${prefix}lume-plugin.json`, format: "lume" },
    { path: `${prefix}.codex-plugin/plugin.json`, format: "codex" },
    { path: `${prefix}plugin.json`, format: "legacy" },
  ];
}

export function rawGitHubUrl(
  source: Extract<PluginSourceRef, { type: "github" }>,
  path: string,
): string {
  if (source.mirrorRawBaseUrl)
    return new URL(
      path.replace(/^\/+/, ""),
      ensureTrailingSlash(source.mirrorRawBaseUrl),
    ).toString();
  return `https://raw.githubusercontent.com/${source.owner}/${source.repo}/${source.ref}/${path}`;
}

export interface PluginMarketGitHubDeps {
  requestRemote(url: string, init?: RequestInit): Promise<Response>;
  fetchText(url: string): Promise<string>;
  /** #525-10:signal 贯穿 + 分块字节上限的 body 统一消费口 */
  readRemoteBody(response: Response, maxBytes?: number, oversize?: () => Error): Promise<Buffer>;
  writeRemoteBodyToFile(response: Response, target: string, maxBytes: number, oversize?: () => Error): Promise<number>;
}

export function createPluginMarketGitHubAdapter(deps: PluginMarketGitHubDeps) {
  async function readGitHubApiJson<T>(response: Response): Promise<T> {
    return JSON.parse((await deps.readRemoteBody(response, GITHUB_API_MAX_BYTES)).toString("utf8")) as T;
  }

  async function inspectGitHubPlugin(
    source: Extract<PluginSourceRef, { type: "github" }>,
    tree?: GitHubTreeEntry[] | null,
  ): Promise<NormalizedPlugin> {
    const { raw, format } = await fetchGitHubManifest(source, tree);
    try {
      return normalizePluginManifests({
        pluginRoot: `github:${source.owner}/${source.repo}/${source.ref}${source.subdir ? `/${source.subdir}` : ""}`,
        lumeManifest:
          format === "lume"
            ? (JSON.parse(raw) as Record<string, unknown>)
            : undefined,
        codexManifest:
          format === "codex"
            ? (JSON.parse(raw) as Record<string, unknown>)
            : undefined,
        legacyManifest:
          format === "legacy"
            ? (JSON.parse(raw) as Record<string, unknown>)
            : undefined,
      });
    } catch (error) {
      throw new PluginMarketError(
        "invalid_manifest",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async function fetchGitHubManifest(
    source: Extract<PluginSourceRef, { type: "github" }>,
    tree?: GitHubTreeEntry[] | null,
  ): Promise<GitHubManifestMatch & { raw: string }> {
    if (source.mirrorRawBaseUrl) return fetchGitHubManifestFromRaw(source);
    if (tree === null) return fetchGitHubManifestFromRaw(source);
    try {
      const resolvedTree = tree ?? (await fetchGitHubTree(source));
      const match = resolveGitHubManifestPath(resolvedTree, source.subdir);
      return {
        ...match,
        raw: await deps.fetchText(rawGitHubUrl(source, match.path)),
      };
    } catch {
      return fetchGitHubManifestFromRaw(source);
    }
  }

  async function fetchGitHubManifestFromRaw(
    source: Extract<PluginSourceRef, { type: "github" }>,
  ): Promise<GitHubManifestMatch & { raw: string }> {
    let lastError: unknown;
    for (const match of githubManifestCandidates(source.subdir)) {
      try {
        return {
          ...match,
          raw: await deps.fetchText(rawGitHubUrl(source, match.path)),
        };
      } catch (error) {
        lastError = error;
      }
    }

    const suffix = lastError instanceof Error ? `: ${lastError.message}` : "";
    throw new PluginMarketError(
      "invalid_manifest",
      `GitHub 仓库中没有检测到 .lume-plugin/plugin.json 或 .codex-plugin/plugin.json${suffix}`,
    );
  }

  async function readGitHubReadme(
    source: Extract<PluginSourceRef, { type: "github" }>,
  ): Promise<PluginReadmePreview | undefined> {
    if (source.mirrorReadmeUrl) {
      const url = new URL(source.mirrorReadmeUrl);
      return truncateReadme(await deps.fetchText(url.toString()), url.pathname);
    }
    const tree = await fetchGitHubTree(source);
    const prefix = source.subdir ? `${source.subdir.replace(/\/$/, "")}/` : "";
    const match = tree.find(
      (entry) =>
        entry.type === "blob" &&
        entry.path.toLowerCase() === `${prefix}readme.md`.toLowerCase(),
    );
    if (!match) return undefined;
    return truncateReadme(
      await deps.fetchText(rawGitHubUrl(source, match.path)),
      match.path,
    );
  }

  async function fetchGitHubTree(
    source: Extract<PluginSourceRef, { type: "github" }>,
  ): Promise<GitHubTreeEntry[]> {
    const response = await deps.requestRemote(
      `https://api.github.com/repos/${source.owner}/${source.repo}/git/trees/${encodeURIComponent(source.ref)}?recursive=1`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "Lume-Plugin-Market",
        },
      },
    );
    if (!response.ok) {
      throw new PluginMarketError(
        "network_failed",
        `读取 GitHub 仓库树失败: ${response.status}`,
      );
    }
    const payload = await readGitHubApiJson<{ tree?: GitHubTreeEntry[] }>(response);
    return payload.tree ?? [];
  }

  async function resolveGitHubRoot(url: string): Promise<GitHubRepoRoot> {
    const parsed = parseGitHubRootUrl(url);
    let ref = parsed.ref;
    if (!ref) {
      try {
        const response = await deps.requestRemote(
          `https://api.github.com/repos/${parsed.owner}/${parsed.repo}`,
          {
            headers: {
              Accept: "application/vnd.github+json",
              "User-Agent": "Lume-Plugin-Market",
            },
          },
        );
        if (response.ok) {
          const payload = await readGitHubApiJson<{
            default_branch?: string;
          }>(response);
          if (typeof payload.default_branch === "string")
            ref = payload.default_branch;
        }
      } catch {
        /* git ls-remote fallback below */
      }
      if (!ref)
        return {
          ...parsed,
          ref: await resolveGitHubCommitWithGit(parsed.owner, parsed.repo),
        };
    }
    const resolvedRef = ref;
    return {
      ...parsed,
      ref: await resolveGitHubCommitSha(parsed.owner, parsed.repo, resolvedRef),
    };
  }

  async function resolveGitHubCommitSha(
    owner: string,
    repo: string,
    ref: string,
  ): Promise<string> {
    if (/^[a-f0-9]{40}$/i.test(ref)) return ref.toLowerCase();
    try {
      const response = await deps.requestRemote(
        `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`,
        {
          headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": "Lume-Plugin-Market",
          },
        },
      );
      if (response.ok) {
        const commit = await readGitHubApiJson<{ sha?: string }>(response);
        if (commit.sha && /^[a-f0-9]{40}$/i.test(commit.sha))
          return commit.sha.toLowerCase();
      }
    } catch {
      /* git ls-remote fallback below */
    }
    return resolveGitHubCommitWithGit(owner, repo, ref);
  }

  async function stageGitHubTarball(
    source: Extract<PluginSourceRef, { type: "github" }>,
    stage: string,
  ): Promise<void> {
    const archiveUrl =
      source.mirrorArchiveUrl ??
      `https://api.github.com/repos/${source.owner}/${source.repo}/tarball/${encodeURIComponent(source.ref)}`;
    const response = await deps.requestRemote(archiveUrl, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "Lume-Plugin-Market",
      },
    });
    if (!response.ok) {
      throw new PluginMarketError(
        "install_failed",
        `下载 GitHub tarball 失败: ${response.status}`,
      );
    }
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > GITHUB_ARCHIVE_MAX_BYTES
    ) {
      throw new PluginMarketError(
        "install_failed",
        "GitHub 源归档超过 512 MB 限制",
      );
    }
    await mkdir(stage, { recursive: true });
    const archive = join(stage, "source.tar.gz");
    // #525-10:边读边写磁盘并累计上限；不再把最多 512MB 的 chunk
    // 收集成单个 Buffer 后才落盘。
    await deps.writeRemoteBodyToFile(
      response,
      archive,
      GITHUB_ARCHIVE_MAX_BYTES,
      () => new PluginMarketError("install_failed", "GitHub 源归档超过 512 MB 限制"),
    );
    const listed = await execFileAsync("tar", ["-tzf", archive], {
      maxBuffer: 8 * 1024 * 1024,
    });
    for (const entry of listed.stdout.split(/\r?\n/).filter(Boolean)) {
      const normalized = posix.normalize(entry.replace(/\\/g, "/"));
      if (
        normalized.startsWith("/") ||
        normalized === ".." ||
        normalized.startsWith("../") ||
        /^[a-zA-Z]:/.test(normalized)
      ) {
        throw new PluginMarketError(
          "install_failed",
          "GitHub 源归档包含越界路径",
        );
      }
    }
    const verbose = await execFileAsync("tar", ["-tvzf", archive], {
      maxBuffer: 16 * 1024 * 1024,
    });
    if (verbose.stdout.split(/\r?\n/).some((line) => /^[lh]/.test(line))) {
      throw new PluginMarketError(
        "install_failed",
        "GitHub 源归档包含链接条目",
      );
    }
    await execFileAsync(
      "tar",
      source.mirrorArchiveUrl
        ? ["-xzf", archive, "-C", stage]
        : ["-xzf", archive, "-C", stage, "--strip-components=1"],
    );
    await rm(archive, { force: true });
    if (source.subdir) {
      const nested = join(stage, source.subdir);
      const temp = `${stage}-subdir`;
      await rename(nested, temp);
      await rm(stage, { recursive: true, force: true });
      await rename(temp, stage);
    }
  }

  return {
    inspectGitHubPlugin,
    fetchGitHubManifest,
    fetchGitHubManifestFromRaw,
    readGitHubReadme,
    fetchGitHubTree,
    resolveGitHubRoot,
    resolveGitHubCommitSha,
    stageGitHubTarball,
  };
}

export function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

export function joinPosix(...segments: Array<string | undefined>): string {
  const filtered = segments
    .filter((segment): segment is string => !!segment && segment !== ".")
    .map((segment) => segment.replace(/^\/+|\/+$/g, ""));
  return posix.normalize(filtered.join("/") || "").replace(/^\.$/, "");
}
