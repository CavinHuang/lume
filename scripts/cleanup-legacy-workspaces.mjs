import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const WORKSPACES_DIR = resolve(homedir(), ".lume", "agent-workspaces");
const APPLY = process.argv.includes("--apply");

function looksLikeThreadId(name) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(name);
}

function ensureDir(path) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

function detectWorkspace(workspacePath) {
  const entries = readdirSync(workspacePath, { withFileTypes: true });
  const names = new Set(entries.map((entry) => entry.name));
  const workspaceName = workspacePath.split(/[\\/]/).filter(Boolean).pop() ?? "";
  const legacyThreadDirs = entries
    .filter((entry) => entry.isDirectory() && looksLikeThreadId(entry.name))
    .map((entry) => entry.name);
  const legacySqliteFiles = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) =>
      name === `${workspaceName}.sqlite`
      || name === `${workspaceName}.sqlite-shm`
      || name === `${workspaceName}.sqlite-wal`
    );

  return {
    workspacePath,
    hasBootstrap: names.has("BOOTSTRAP.md"),
    hasClaudePlugin: names.has(".claude-plugin"),
    legacyThreadDirs,
    legacySqliteFiles
  };
}

function applyWorkspaceFixes(report) {
  const actions = [];

  if (report.hasBootstrap) {
    const target = join(report.workspacePath, "BOOTSTRAP.md");
    rmSync(target, { force: true });
    actions.push(`removed ${target}`);
  }

  if (report.hasClaudePlugin) {
    const target = join(report.workspacePath, ".claude-plugin");
    rmSync(target, { recursive: true, force: true });
    actions.push(`removed ${target}`);
  }

  if (report.legacyThreadDirs.length > 0) {
    const threadsDir = join(report.workspacePath, "threads");
    ensureDir(threadsDir);
    for (const dirName of report.legacyThreadDirs) {
      const source = join(report.workspacePath, dirName);
      const target = join(threadsDir, dirName);
      if (!existsSync(source)) continue;
      if (existsSync(target)) {
        rmSync(source, { recursive: true, force: true });
        actions.push(`removed duplicate legacy thread dir ${source} (canonical target exists at ${target})`);
        continue;
      }
      renameSync(source, target);
      actions.push(`moved ${source} -> ${target}`);
    }
  }

  if (report.legacySqliteFiles.length > 0) {
    const metaDir = join(report.workspacePath, ".meta");
    ensureDir(metaDir);
    for (const fileName of report.legacySqliteFiles) {
      const source = join(report.workspacePath, fileName);
      const target = join(metaDir, fileName);
      if (!existsSync(source)) continue;
      if (existsSync(target)) {
        rmSync(source, { force: true });
        actions.push(`removed duplicate sqlite artifact ${source} (canonical target exists at ${target})`);
        continue;
      }
      renameSync(source, target);
      actions.push(`moved ${source} -> ${target}`);
    }
  }

  return actions;
}

function main() {
  if (!existsSync(WORKSPACES_DIR) || !statSync(WORKSPACES_DIR).isDirectory()) {
    console.log(`No agent workspaces found: ${WORKSPACES_DIR}`);
    return;
  }

  const workspaceEntries = readdirSync(WORKSPACES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(WORKSPACES_DIR, entry.name));

  const reports = workspaceEntries.map(detectWorkspace).filter((report) =>
    report.hasBootstrap
    || report.hasClaudePlugin
    || report.legacyThreadDirs.length > 0
    || report.legacySqliteFiles.length > 0
  );

  if (reports.length === 0) {
    console.log("No legacy workspace layout detected.");
    return;
  }

  for (const report of reports) {
    console.log(`Workspace: ${report.workspacePath}`);
    if (report.hasBootstrap) console.log("  - legacy file: BOOTSTRAP.md");
    if (report.hasClaudePlugin) console.log("  - legacy dir: .claude-plugin");
    if (report.legacyThreadDirs.length > 0) {
      console.log(`  - legacy thread dirs at root: ${report.legacyThreadDirs.join(", ")}`);
    }
    if (report.legacySqliteFiles.length > 0) {
      console.log(`  - legacy sqlite files at root: ${report.legacySqliteFiles.join(", ")}`);
    }
    if (APPLY) {
      const actions = applyWorkspaceFixes(report);
      for (const action of actions) {
        console.log(`    * ${action}`);
      }
    }
  }

  if (!APPLY) {
    console.log("");
    console.log("Dry run only. Re-run with --apply to mutate the legacy workspace layout.");
  }
}

main();
