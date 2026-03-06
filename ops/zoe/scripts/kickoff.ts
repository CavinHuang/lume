#!/usr/bin/env bun
/**
 * Zoe kickoff script (minimal v1)
 *
 * Usage:
 *   bun ops/zoe/scripts/kickoff.ts ops/zoe/tasks/001-something.md
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

type RegistryTask = {
  id: string;
  slug: string;
  title: string;
  taskFile: string;
  repoRoot: string;
  worktreeDir: string;
  branch: string;
  tmuxSession: string;
  createdAt: string;
};

type Registry = {
  version: 1;
  tasks: RegistryTask[];
};

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function sh(cmd: string, args: string[], opts?: { cwd?: string }) {
  const r = spawnSync(cmd, args, {
    cwd: opts?.cwd,
    stdio: "pipe",
    encoding: "utf8",
  });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    const out = (r.stdout || "") + (r.stderr || "");
    throw new Error(`${cmd} ${args.join(" ")} failed (${r.status})\n${out}`);
  }
  return (r.stdout || "").trim();
}

function exists(cmd: string) {
  const r = spawnSync(cmd, ["--version"], { stdio: "ignore" });
  return r.status === 0;
}

function slugify(s: string) {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function parseTask(md: string): { title: string } {
  const m = md.match(/^#\s*(.+)\s*$/m);
  if (m) return { title: m[1].trim() };
  return { title: "task" };
}

function taskIdFromPath(taskFile: string) {
  const base = path.basename(taskFile);
  const m = base.match(/^(\d{3,})[-_]/);
  if (m) return m[1];
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    String(d.getFullYear()) +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

function readRegistry(regPath: string): Registry {
  if (!fs.existsSync(regPath)) return { version: 1, tasks: [] };
  return JSON.parse(fs.readFileSync(regPath, "utf8"));
}

function writeRegistry(regPath: string, reg: Registry) {
  fs.writeFileSync(regPath, JSON.stringify(reg, null, 2) + "\n", "utf8");
}

function main() {
  const taskFile = process.argv[2];
  if (!taskFile) die("Usage: bun ops/zoe/scripts/kickoff.ts <task-md-path>");

  const repoRoot = sh("git", ["rev-parse", "--show-toplevel"]);
  const absTask = path.resolve(repoRoot, taskFile);
  if (!fs.existsSync(absTask)) die(`Task file not found: ${absTask}`);

  const md = fs.readFileSync(absTask, "utf8");
  const { title } = parseTask(md);

  const id = taskIdFromPath(absTask);
  const slug = slugify(title) || slugify(path.basename(absTask, path.extname(absTask)));
  const branch = `feat/${slug || `task-${id}`}`;

  const parentDir = path.dirname(repoRoot);
  const worktreeDir = path.join(parentDir, `Lume-wt-${id}`);
  const tmuxSession = `lume:${id}`;

  console.log(`repoRoot:     ${repoRoot}`);
  console.log(`task:         ${absTask}`);
  console.log(`id:           ${id}`);
  console.log(`title:        ${title}`);
  console.log(`branch:       ${branch}`);
  console.log(`worktreeDir:  ${worktreeDir}`);
  console.log(`tmuxSession:  ${tmuxSession}`);

  if (!fs.existsSync(worktreeDir)) {
    console.log("Creating worktree...");
    sh("git", ["worktree", "add", worktreeDir, "-b", branch], { cwd: repoRoot });
  } else {
    console.log("Worktree already exists, skipping create.");
  }

  const regPath = path.join(repoRoot, ".clawdbot", "active-tasks.json");
  const reg = readRegistry(regPath);
  const existing = reg.tasks.find((t) => t.id == id);
  const now = new Date().toISOString();
  const rec: RegistryTask =
    existing ??
    ({
      id,
      slug,
      title,
      taskFile: path.relative(repoRoot, absTask),
      repoRoot,
      worktreeDir,
      branch,
      tmuxSession,
      createdAt: now,
    } satisfies RegistryTask);
  if (!existing) {
    reg.tasks.push(rec);
    writeRegistry(regPath, reg);
    console.log(`Registered: ${regPath}`);
  } else {
    console.log("Already registered.");
  }

  if (!exists("tmux")) {
    console.log("tmux not found in PATH. Skipping tmux session creation.");
    console.log(`Next: cd ${worktreeDir} && codex  (and claude for review)`);
    return;
  }

  const hasSession = spawnSync("tmux", ["has-session", "-t", tmuxSession], {
    stdio: "ignore",
  }).status === 0;

  if (!hasSession) {
    console.log("Creating tmux session...");
    sh("tmux", ["new-session", "-d", "-s", tmuxSession, "-c", worktreeDir]);
    sh("tmux", ["split-window", "-h", "-t", tmuxSession, "-c", worktreeDir]);
    sh("tmux", ["select-layout", "-t", tmuxSession, "even-horizontal"]);

    sh("tmux", ["send-keys", "-t", `${tmuxSession}.0`, `codex`, "Enter"]);
    sh("tmux", ["send-keys", "-t", `${tmuxSession}.1`, `claude`, "Enter"]);

    const note = `\\n# Task file: ${path.relative(repoRoot, absTask)}\\n# Worktree: ${worktreeDir}\\n`;
    sh("tmux", ["send-keys", "-t", `${tmuxSession}.0`, note, "Enter"]);
    sh("tmux", ["send-keys", "-t", `${tmuxSession}.1`, note, "Enter"]);
  } else {
    console.log("tmux session already exists.");
  }

  console.log(`Attach: tmux attach -t ${tmuxSession}`);
}

main();
