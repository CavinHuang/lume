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

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log("Usage: bun scripts/release.mjs <version> [--patch|--minor|--major]");
    console.log("  version: target version tag, e.g. v0.1.1");
    console.log("  --patch/--minor/--major: auto-bump type (default: patch)");
    process.exit(0);
  }

  const targetTag = args.find(a => a.startsWith("v"));
  if (!targetTag) {
    console.error("Error: version tag required (e.g. v0.1.1)");
    process.exit(1);
  }
  const bumpType = args.includes("--major") ? "major"
    : args.includes("--minor") ? "minor"
    : "patch";

  // 1. Check clean working tree
  console.log("\n📋 Checking working tree...");
  const status = run("git", ["status", "--porcelain"]);
  if (status) {
    console.error("Error: working tree is not clean:\n" + status);
    process.exit(1);
  }
  console.log("  ✓ Clean");

  // 2. Get last tag
  console.log("\n🏷️  Finding last tag...");
  const lastTag = getLastTag();
  console.log(`  Last tag: ${lastTag || "(none)"}`);

  // 3. Extract commits
  console.log(`\n📝 Commits since ${lastTag || "beginning"}:`);
  const rawLog = getCommitsSince(lastTag);
  if (!rawLog) {
    console.error("Error: no commits found");
    process.exit(1);
  }
  console.log(rawLog);

  const grouped = parseCommits(rawLog);
  const totalCommits = Object.values(grouped).reduce((sum, arr) => sum + arr.length, 0);
  console.log(`\n  Total: ${totalCommits} commit(s)`);

  // 4. Confirm continue
  console.log(`\n🔖 Target version: ${targetTag} (${bumpType} bump)`);
  const readline = await import("node:readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise(resolve =>
    rl.question("Continue? [Y/n] ", resolve)
  );
  rl.close();
  if (answer.toLowerCase() === "n") {
    console.log("Aborted.");
    process.exit(0);
  }

  // 5. Determine new version
  const rootPkg = JSON.parse(run("git", ["show", "HEAD:package.json"]));
  const currentVersion = rootPkg.version;
  const newVersion = bumpVersion(currentVersion, bumpType);
  console.log(`\n🔢 Version: ${currentVersion} → ${newVersion}`);

  // 6. Generate and show release notes
  console.log("\n📄 Generating release notes...");
  const notesPath = generateReleaseNotes(targetTag, grouped);

  const notesContent = readFileSync(notesPath, "utf-8");
  console.log("\n--- Release Notes Preview ---");
  console.log(notesContent);
  console.log("--- End ---\n");

  const confirm = await new Promise(resolve => {
    const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl2.question("Accept release notes? [Y/n] ", answer => {
      rl2.close();
      resolve(answer.toLowerCase());
    });
  });
  if (confirm === "n") {
    console.log("Aborted.");
    process.exit(0);
  }

  // 7. Bump versions in 3 files
  console.log("\n🔧 Bumping versions...");
  await updateJsonFile(resolve(REPO_ROOT, "package.json"), newVersion);
  await updateJsonFile(resolve(REPO_ROOT, "apps", "desktop", "package.json"), newVersion);
  await updateJsonFile(resolve(REPO_ROOT, "apps", "desktop", "src-tauri", "tauri.conf.json"), newVersion);

  // 8. Commit
  console.log("\n📦 Committing...");
  run("git", ["add",
    "package.json",
    "apps/desktop/package.json",
    "apps/desktop/src-tauri/tauri.conf.json",
    notesPath,
  ]);
  run("git", ["commit", "-m", `chore: release ${targetTag}`]);
  console.log("  ✓ Committed");

  // 9. Push
  console.log("\n🚀 Pushing...");
  run("git", ["push"]);
  console.log("  ✓ Pushed");

  // 10. Tag
  console.log("\n🏷️  Tagging...");
  run("git", ["tag", targetTag]);
  run("git", ["push", "origin", targetTag]);
  console.log(`  ✓ Tag ${targetTag} pushed`);

  console.log(`\n✅ Release ${targetTag} complete!`);
  console.log(`   CI will build and create a draft release.`);
  console.log(`   Release notes: ${notesPath}`);
}

main().catch(err => {
  console.error(`\n❌ ${err.message}`);
  process.exit(1);
});
