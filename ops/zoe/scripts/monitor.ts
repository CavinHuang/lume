#!/usr/bin/env bun
/**
 * Zoe monitor script (minimal v1)
 *
 * Usage:
 *   bun ops/zoe/scripts/monitor.ts
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

type Registry = { version: 1; tasks: RegistryTask[] };

function sh(cmd: string, args: string[], opts?: { cwd?: string }) {
  const r = spawnSync(cmd, args, { cwd: opts?.cwd, encoding: "utf8" });
  if (r.error) throw r.error;
  return { code: r.status ?? 0, out: (r.stdout || "") + (r.stderr || "") };
}

function readRegistry(repoRoot: string): Registry {
  const p = path.join(repoRoot, ".clawdbot", "active-tasks.json");
  if (!fs.existsSync(p)) return { version: 1, tasks: [] };
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function main() {
  const repoRoot = sh("git", ["rev-parse", "--show-toplevel"]).out.trim();
  const reg = readRegistry(repoRoot);
  if (!reg.tasks.length) {
    console.log("No active tasks.");
    return;
  }

  for (const t of reg.tasks) {
    console.log("\n===" );
    console.log(`# ${t.id}  ${t.title}`);
    console.log(`- branch:   ${t.branch}`);
    console.log(`- worktree: ${t.worktreeDir}`);
    console.log(`- tmux:     ${t.tmuxSession}`);

    const s1 = sh("git", ["-C", t.worktreeDir, "status", "-sb"]);
    process.stdout.write(s1.out);

    const s2 = sh("git", ["-C", t.worktreeDir, "log", "-1", "--oneline"]);
    process.stdout.write(s2.out);

    const dirty = sh("git", ["-C", t.worktreeDir, "status", "--porcelain=v1"]).out.trim();
    if (dirty) {
      console.log("- dirty: yes");
    } else {
      console.log("- dirty: no");
    }
  }
}

main();
