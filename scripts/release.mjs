import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    stdio: "pipe",
    ...opts,
  });
  if (result.status !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim() || `exit ${result.status}`;
    throw new Error(`Command failed: ${cmd} ${args.join(" ")}\n${detail}`);
  }
  return result.stdout.trim();
}

function getLastTag() {
  try {
    return run("git", ["describe", "--tags", "--abbrev=0"]);
  } catch {
    return null; // no tags yet
  }
}

function getCommitsSince(tag) {
  if (tag) {
    return run("git", ["log", `${tag}..HEAD`, "--oneline"]);
  }
  return run("git", ["log", "--oneline"]);
}

function parseCommits(log) {
  const lines = log.split("\n").filter(Boolean);
  const groups = { feat: [], fix: [], chore: [], refactor: [], docs: [], other: [] };
  for (const line of lines) {
    const match = line.match(/^(\w+)(\([^)]*\))?[:\s]/);
    if (match) {
      const type = match[1];
      if (groups[type]) {
        groups[type].push(line);
      } else {
        groups.other.push(line);
      }
    } else {
      groups.other.push(line);
    }
  }
  return groups;
}

function bumpVersion(version, type) {
  const parts = version.split(".").map(p => parseInt(p, 10));
  if (parts.length !== 3 || parts.some(isNaN)) {
    throw new Error(`Invalid version format: ${version}. Expected x.y.z`);
  }
  const [major, minor, patch] = parts;
  if (type === "major") return `${major + 1}.0.0`;
  if (type === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

async function updateJsonFile(path, newVersion) {
  const content = readFileSync(path, "utf-8");
  const updated = content.replace(
    /"version":\s*"[^"]+"/,
    `"version": "${newVersion}"`
  );
  if (updated === content) {
    throw new Error(`Version not found in ${path}`);
  }
  writeFileSync(path, updated);
  console.log(`  ✓ ${path} → ${newVersion}`);
}

export {
  REPO_ROOT,
  run,
  getLastTag,
  getCommitsSince,
  parseCommits,
  bumpVersion,
  updateJsonFile,
};

function generateReleaseNotes(tag, groupedCommits) {
  const notesDir = resolve(REPO_ROOT, "docs", "release");
  mkdirSync(notesDir, { recursive: true });

  const filePath = resolve(notesDir, `${tag}.md`);
  const sections = [];

  // Header
  sections.push(`# Lume ${tag}\n`);

  // Highlights — pick top 1-2 feat commits
  const topFeats = groupedCommits.feat.slice(0, 2);
  if (topFeats.length > 0) {
    sections.push("## Highlights\n");
    topFeats.forEach(line => {
      const text = line.replace(/^feat(\([^)]*\))?:\s*/, "");
      sections.push(`- ${text}`);
    });
    sections.push("");
  }

  // What's Changed
  sections.push("## What's Changed\n");
  const order = ["feat", "fix", "refactor", "docs", "chore"];
  for (const type of order) {
    const lines = groupedCommits[type];
    if (lines.length > 0) {
      const label = type.charAt(0).toUpperCase() + type.slice(1);
      lines.forEach(line => {
        sections.push(`- ${line}`);
      });
      sections.push("");
    }
  }
  if (groupedCommits.other.length > 0) {
    groupedCommits.other.forEach(line => sections.push(`- ${line}`));
    sections.push("");
  }

  // Build info
  sections.push("## Build Info\n");
  sections.push("- Platforms: macOS (ARM/Intel), Windows, Linux");
  sections.push("- Updater: ✅ signed\n");

  writeFileSync(filePath, sections.join("\n"), "utf-8");
  console.log(`  ✓ Release notes: ${filePath}`);
  return filePath;
}

export { generateReleaseNotes };
