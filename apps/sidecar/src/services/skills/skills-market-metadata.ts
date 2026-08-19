import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getWorkspaceMetaPath } from "../infra/config-paths";

export type InstalledSkillSourceMeta =
  | {
    sourceType: "github";
    sourceRef: string;
    trustLevel: "review-required";
    ref: string;
    /** 安装时钉住的 commit SHA（存量 version 1 元数据无此字段） */
    commitSha?: string;
    rootPath: string;
    installedAt: number;
  }
  | {
    sourceType: "local";
    sourcePath: string;
    trustLevel: "trusted";
    installedAt: number;
  };

interface SkillsMarketMetadataFile {
  version: 1;
  installedSources: Record<string, InstalledSkillSourceMeta>;
}

const METADATA_FILENAME = "skills-market.json";

function getMetadataPath(workspaceSlug: string): string {
  return join(getWorkspaceMetaPath(workspaceSlug), METADATA_FILENAME);
}

function readMetadata(workspaceSlug: string): SkillsMarketMetadataFile {
  const metadataPath = getMetadataPath(workspaceSlug);
  if (!existsSync(metadataPath)) {
    return { version: 1, installedSources: {} };
  }

  try {
    return JSON.parse(readFileSync(metadataPath, "utf-8")) as SkillsMarketMetadataFile;
  } catch {
    return { version: 1, installedSources: {} };
  }
}

function writeMetadata(workspaceSlug: string, data: SkillsMarketMetadataFile): void {
  const metadataPath = getMetadataPath(workspaceSlug);
  const tmpPath = `${metadataPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
  renameSync(tmpPath, metadataPath);
}

export function getInstalledSkillSourceMetadata(workspaceSlug: string): Record<string, InstalledSkillSourceMeta> {
  return readMetadata(workspaceSlug).installedSources;
}

export function saveGitHubInstalledSkillMetadata(input: {
  workspaceSlug: string;
  slugs: string[];
  sourceRef: string;
  ref: string;
  commitSha?: string;
  rootPath: string;
}): void {
  const current = readMetadata(input.workspaceSlug);
  const next: SkillsMarketMetadataFile = {
    version: 1,
    installedSources: { ...current.installedSources }
  };

  for (const slug of input.slugs) {
    next.installedSources[slug] = {
      sourceType: "github",
      sourceRef: input.sourceRef,
      trustLevel: "review-required",
      ref: input.ref,
      ...(input.commitSha ? { commitSha: input.commitSha } : {}),
      rootPath: input.rootPath,
      installedAt: Date.now()
    };
  }

  writeMetadata(input.workspaceSlug, next);
}

export function saveLocalInstalledSkillMetadata(input: {
  workspaceSlug: string;
  skills: Array<{ slug: string; sourcePath: string }>;
}): void {
  const current = readMetadata(input.workspaceSlug);
  const next: SkillsMarketMetadataFile = {
    version: 1,
    installedSources: { ...current.installedSources }
  };

  for (const skill of input.skills) {
    next.installedSources[skill.slug] = {
      sourceType: "local",
      sourcePath: skill.sourcePath,
      trustLevel: "trusted",
      installedAt: Date.now()
    };
  }

  writeMetadata(input.workspaceSlug, next);
}
