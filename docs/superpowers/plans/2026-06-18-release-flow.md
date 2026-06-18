# Release Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local release skill that automates version bump, release notes generation, commit, tag, and push — with CI reading release notes from `docs/release/<tag>.md` to create the GitHub Release.

**Architecture:** A single Bun script (`scripts/release.mjs`) handles the full local release flow. The CI workflow reads the generated markdown file as the release body. No external dependencies — uses Node.js built-ins and `spawnSync` for git/bun commands, matching the style of existing scripts in `scripts/`.

**Tech Stack:** Node.js `.mjs`, `child_process.spawnSync`, existing repo tooling (bun, git)

**Files:**
- Create: `scripts/release.mjs`
- Modify: `.github/workflows/release-desktop.yml`

---

## Task 1: Utility Functions

**Files:**
- Create: `scripts/release.mjs`

- [ ] **Step 1: Write the script header and utility functions**

Create `scripts/release.mjs` with the following content:

```javascript
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

function updateJsonFile(path, newVersion) {
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
```

- [ ] **Step 2: Verify syntax**

Run: `bun scripts/release.mjs`
Expected: `ReferenceError: Cannot access 'await' outside a module` or `--help` (script has no top-level `run()` call yet, but should parse without syntax errors)

- [ ] **Step 3: Commit**

```bash
git add scripts/release.mjs
git commit -m "feat: add release script skeleton"
```

---

## Task 2: Release Notes Generation

**Files:**
- Create: `scripts/release.mjs` (append to existing file)

- [ ] **Step 1: Write the `generateReleaseNotes` function**

Append this function to `scripts/release.mjs`:

```javascript
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

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
      // Strip the "feat(scope):" prefix for readability
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
```

- [ ] **Step 2: Verify syntax**

Run: `bun scripts/release.mjs`
Expected: No syntax errors

- [ ] **Step 3: Commit**

```bash
git add scripts/release.mjs
git commit -m "feat: add release notes generation"
```

---

## Task 3: Main Interactive Flow

**Files:**
- Create: `scripts/release.mjs` (append to existing file)

- [ ] **Step 1: Write the `main` async function**

Append this to `scripts/release.mjs`:

```javascript
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

  const notesContent = run("git", ["show", `HEAD:${notesPath}`]);
  console.log("\n--- Release Notes Preview ---");
  console.log(notesContent);
  console.log("--- End ---\n");

  const confirm = await new Promise(resolve => {
    const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl2.question("Accept release notes? [Y/n/edit] ", answer => {
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
  updateJsonFile(resolve(REPO_ROOT, "package.json"), newVersion);
  updateJsonFile(resolve(REPO_ROOT, "apps", "desktop", "package.json"), newVersion);
  updateJsonFile(resolve(REPO_ROOT, "apps", "desktop", "src-tauri", "tauri.conf.json"), newVersion);

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
```

- [ ] **Step 2: Verify syntax**

Run: `bun scripts/release.mjs`
Expected: `Usage: bun scripts/release.mjs <version> [--patch|--minor|--major]`

- [ ] **Step 3: Dry-run test**

From a clean working tree, run:
```bash
bun scripts/release.mjs v0.0.2 --patch
```
When prompted, type `n` to abort.
Expected: Script runs through checks, shows commits, prompts for confirmation, exits cleanly after "Aborted."

- [ ] **Step 4: Commit**

```bash
git add scripts/release.mjs
git commit -m "feat: add release script main flow"
```

---

## Task 4: CI Workflow — Read Release Notes

**Files:**
- Modify: `.github/workflows/release-desktop.yml`

- [ ] **Step 1: Add "Read release notes" step before tauri-action**

In `.github/workflows/release-desktop.yml`, add a new step between "Prepare desktop bundle resources" and "Build and upload Tauri bundles":

```yaml
      - name: Read release notes
        id: release_notes
        run: |
          if [ -f "docs/release/${{ github.ref_name }}.md" ]; then
            echo "body<<EOF" >> $GITHUB_OUTPUT
            cat docs/release/${{ github.ref_name }}.md >> $GITHUB_OUTPUT
            echo "EOF" >> $GITHUB_OUTPUT
          else
            echo "body=No release notes found for ${{ github.ref_name }}." >> $GITHUB_OUTPUT
          fi
```

- [ ] **Step 2: Pass release notes to tauri-action**

Change the `releaseBody` line in the tauri-action step from:
```yaml
          releaseBody: "Desktop release for ${{ github.ref_name }}."
```
to:
```yaml
          releaseBody: ${{ steps.release_notes.outputs.body }}
```

- [ ] **Step 3: Verify YAML syntax**

Run: `bun x js-yaml .github/workflows/release-desktop.yml`
Or check with: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release-desktop.yml'))"`
Expected: No error

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/release-desktop.yml
git commit -m "feat(ci): read release notes from docs/release/<tag>.md"
```

---

## Task 5: Manual — Create RELEASE_TOKEN Secret

**This step cannot be automated — it requires GitHub UI interaction.**

- [ ] **Step 1: Create a Personal Access Token**

1. Go to https://github.com/settings/tokens
2. Click "Generate new token (classic)"
3. Note: `lume-release`
4. Scopes: check `repo` (full control of private repositories)
5. Expiration: set as needed (e.g., 1 year)
6. Generate and **copy the token value**

- [ ] **Step 2: Store as GitHub Secret**

1. Go to the repo → Settings → Secrets and variables → Actions
2. Under "Repository secrets", click "New repository secret"
3. Name: `RELEASE_TOKEN`
4. Value: paste the PAT
5. Add secret

- [ ] **Step 3: Verify**

Trigger a manual workflow dispatch on any test tag to confirm CI can create releases.

---

## Spec Coverage Checklist

| Spec Requirement | Task |
|---|---|
| Release notes file `docs/release/<tag>.md` | Task 2 |
| Agent skill: analyze log → generate notes → user confirm | Task 3 |
| Bump version in 3 files | Task 3 (step 7) |
| Commit + push + tag | Task 3 (steps 8-10) |
| CI reads release notes from file | Task 4 |
| Fix GITHUB_TOKEN permission (PAT) | Task 5 (manual) |

No gaps.

---

## Rollback

If the release script has issues:
1. Delete the pushed tag: `git push origin :refs/tags/v0.1.1`
2. Revert the version bump commit: `git revert HEAD`
3. Push: `git push`

If CI has issues:
1. Revert the workflow commit
2. Push to restore previous workflow
