import { spawnSync } from "node:child_process";
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
  const [major, minor, patch] = version.split(".").map(Number);
  if (type === "major") return `${major + 1}.0.0`;
  if (type === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

async function updateJsonFile(path, newVersion) {
  const fs = await import("node:fs");
  const content = fs.readFileSync(path, "utf-8");
  const updated = content.replace(
    /"version":\s*"[^"]+"/,
    `"version": "${newVersion}"`
  );
  if (updated === content) {
    throw new Error(`Version not found in ${path}`);
  }
  fs.writeFileSync(path, updated);
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
