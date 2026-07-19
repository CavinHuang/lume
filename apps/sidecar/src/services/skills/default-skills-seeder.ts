/**
 * Seed built-in default skills into ~/.lume/default-skills.
 *
 * Source priority:
 * 1) LUME_DEFAULT_SKILLS_ARCHIVE (desktop/runtime injected tar)
 * 2) LUME_DEFAULT_SKILLS_DIR (desktop/runtime injected directory)
 * 3) <sidecar cwd>/default-skills (dev fallback)
 *
 * Strategy: add missing skills and upgrade bundled skills only when their
 * declared version increases. Unversioned user skills are preserved.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { getDefaultSkillsDir } from "../infra/config-paths";
import { createLogger } from "../infra/logger";

export type DefaultSkillsSource =
  | { kind: "archive"; path: string }
  | { kind: "directory"; path: string };

const log = createLogger("default-skills-seeder");

function resolveBundledDefaultSkillsDir(): string | null {
  const fromEnv = process.env.LUME_DEFAULT_SKILLS_DIR?.trim();
  if (fromEnv) {
    return resolve(fromEnv);
  }

  const fromCwd = resolve(join(process.cwd(), "default-skills"));
  if (existsSync(fromCwd)) {
    return fromCwd;
  }

  return null;
}

function resolveBundledDefaultSkillsSource(): DefaultSkillsSource | null {
  const archive = process.env.LUME_DEFAULT_SKILLS_ARCHIVE?.trim();
  if (archive && existsSync(resolve(archive))) {
    return { kind: "archive", path: resolve(archive) };
  }

  const directory = resolveBundledDefaultSkillsDir();
  return directory ? { kind: "directory", path: directory } : null;
}

export function parseTarString(buffer: Buffer, start: number, length: number): string {
  const raw = buffer.subarray(start, start + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end >= 0 ? end : raw.length).toString("utf8");
}

export function parseTarOctal(buffer: Buffer, start: number, length: number): number {
  const raw = parseTarString(buffer, start, length).trim();
  return raw ? Number.parseInt(raw, 8) : 0;
}

export function safeTargetPath(root: string, relativePath: string): string | null {
  const normalized = normalize(relativePath);
  if (!normalized || normalized.startsWith("..") || normalized.includes(`${sep}..${sep}`)) {
    return null;
  }

  const target = resolve(root, normalized);
  const resolvedRoot = resolve(root);
  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${sep}`)) {
    return null;
  }
  return target;
}

export function extractDefaultSkillsArchive(archivePath: string, userDir: string): void {
  const buffer = readFileSync(archivePath);
  const entries: Array<{ name: string; typeflag: string; content: Buffer }> = [];
  let offset = 0;

  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) {
      break;
    }

    const name = parseTarString(header, 0, 100);
    const size = parseTarOctal(header, 124, 12);
    const typeflag = parseTarString(header, 156, 1) || "0";
    const content = buffer.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;

    entries.push({ name, typeflag, content });
  }

  const bundledVersions = new Map<string, string>();
  for (const entry of entries) {
    const parts = entry.name.split("/").filter(Boolean);
    if (parts.length === 2 && parts[1] === "SKILL.md") {
      bundledVersions.set(parts[0]!, readVersionFromContent(entry.content.toString("utf8")));
    }
  }

  const installableSkills = new Set<string>();
  for (const entry of entries) {
    const skillName = entry.name.split("/").filter(Boolean)[0];
    if (!skillName || installableSkills.has(skillName)) continue;
    const target = join(userDir, skillName);
    if (!existsSync(target) || isNewerBundledVersion(bundledVersions.get(skillName) ?? "0", readSkillVersion(target))) {
      installableSkills.add(skillName);
    }
  }

  for (const entry of entries) {
    const { name, typeflag, content } = entry;
    const skillName = name.split("/").filter(Boolean)[0];
    if (!skillName || !installableSkills.has(skillName)) {
      continue;
    }

    const target = safeTargetPath(userDir, name);
    if (!target) {
      continue;
    }

    if (typeflag === "5") {
      mkdirSync(target, { recursive: true });
      continue;
    }

    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

function readVersionFromContent(content: string): string {
  const match = content.match(/^---\s*\n[\s\S]*?^version:\s*["']?([^"'\n]+)["']?/m);
  return match?.[1]?.trim() ?? "0";
}

function readSkillVersion(skillDir: string): string {
  try {
    return readVersionFromContent(readFileSync(join(skillDir, "SKILL.md"), "utf8"));
  } catch {
    return "0";
  }
}

function isNewerBundledVersion(bundled: string, installed: string): boolean {
  if (bundled === "0" || installed === "0") return false;
  const bundledParts = bundled.split(".").map(Number);
  const installedParts = installed.split(".").map(Number);
  const length = Math.max(bundledParts.length, installedParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (bundledParts[index] ?? 0) - (installedParts[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

export function seedDefaultSkills(): void {
  const source = resolveBundledDefaultSkillsSource();
  if (!source || !existsSync(source.path)) {
    log.info("bundled default skills source missing, skipped");
    return;
  }

  const userDir = getDefaultSkillsDir();

  try {
    if (source.kind === "archive") {
      extractDefaultSkillsArchive(source.path, userDir);
      log.info("default skills archive synced", { source: source.path, target: userDir });
      return;
    }

    const entries = readdirSync(source.path, { withFileTypes: true });
    for (const entry of entries) {
      const sourcePath = join(source.path, entry.name);
      const target = join(userDir, entry.name);
      if (existsSync(target) && !isNewerBundledVersion(readSkillVersion(sourcePath), readSkillVersion(target))) continue;
      cpSync(sourcePath, target, { recursive: true });
      log.info("default skill synced", { skillSlug: entry.name });
    }
  } catch (error) {
    log.warn("default skills sync failed", { error });
  }
}
