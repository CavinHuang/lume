#!/usr/bin/env bun
/**
 * 一次性清理：自动化 skip 风暴遗留的脏数据。
 *
 * 做两件事：
 *   1. runs/all.jsonl：丢弃所有 status==="skipped" 的运行记录（纯噪声，
 *      含义只是「任务仍在运行，已跳过」），保留 success/failed/waiting_for_approval。
 *   2. jobs.json：删除 enabled=false 且未被任何日程(routine/schedules/*.json)
 *      引用的 once 任务。保留：enabled 任务、被日程引用的任务、非 once 任务。
 *
 * 安全约定：
 *   - 默认 dry-run，仅打印计划；确认无误后加 --apply 才真正写入。
 *   - 写入前自动备份原文件为 <path>.bak-<timestamp>。
 *
 * 用法：
 *   bun apps/sidecar/scripts/cleanup-automation-backlog.mjs            # dry-run
 *   bun apps/sidecar/scripts/cleanup-automation-backlog.mjs --apply    # 实际清理
 *   LUME_CONFIG_DIR=/path bun ...cleanup-automation-backlog.mjs --apply
 */
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const APPLY = process.argv.includes("--apply");
const configDir = process.env.LUME_CONFIG_DIR || join(homedir(), ".lume");

const jobsPath = join(configDir, "automation", "jobs.json");
const runsPath = join(configDir, "automation", "runs", "all.jsonl");
const schedulesDir = join(configDir, "routine", "schedules");

function ts() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
function backup(path) {
  const bak = `${path}.bak-${ts()}`;
  renameSync(path, bak);
  return bak;
}

// ---- 收集所有被日程引用的 automationJobId（保护它们不被删除）----
const referencedJobIds = new Set();
if (existsSync(schedulesDir)) {
  for (const file of readdirSync(schedulesDir)) {
    if (!file.endsWith(".json")) continue;
    try {
      const routine = JSON.parse(readFileSync(join(schedulesDir, file), "utf-8"));
      for (const entry of routine?.entries ?? []) {
        if (typeof entry?.automationJobId === "string") {
          referencedJobIds.add(entry.automationJobId);
        }
      }
    } catch {
      // 单个日程文件解析失败不影响整体
    }
  }
}

// ---- 1. runs/all.jsonl：去 skip ----
let runsBefore = 0;
let runsSkipped = 0;
let runsKept = 0;
let keptLines = [];
if (existsSync(runsPath)) {
  const raw = readFileSync(runsPath, "utf-8").split("\n");
  for (const line of raw) {
    if (!line.trim()) continue;
    runsBefore++;
    try {
      const r = JSON.parse(line);
      if (r?.status === "skipped") {
        runsSkipped++;
        continue;
      }
      keptLines.push(line);
      runsKept++;
    } catch {
      // 保留无法解析的行（不擅自删除）
      keptLines.push(line);
      runsKept++;
    }
  }
}

// ---- 2. jobs.json：删 enabled=false 且未被引用的 once 任务 ----
let jobsPayload = null;
let jobsBefore = 0;
const jobsToDelete = [];
const jobsToKeep = [];
if (existsSync(jobsPath)) {
  jobsPayload = JSON.parse(readFileSync(jobsPath, "utf-8"));
  jobsBefore = jobsPayload.jobs?.length ?? 0;
  for (const job of jobsPayload.jobs ?? []) {
    const isOnce = job?.schedule?.type === "once";
    const disabled = job?.enabled === false;
    const referenced = typeof job?.id === "string" && referencedJobIds.has(job.id);
    if (isOnce && disabled && !referenced) {
      jobsToDelete.push(job);
    } else {
      jobsToKeep.push(job);
    }
  }
}

// ---- 报告 ----
console.log(`配置目录: ${configDir}`);
console.log(`被日程引用、受保护的任务数: ${referencedJobIds.size}`);
console.log("");
console.log("[runs/all.jsonl]");
console.log(`  清理前条目: ${runsBefore}`);
console.log(`  将丢弃(skipped): ${runsSkipped}`);
console.log(`  将保留: ${runsKept}`);
console.log("");
console.log("[jobs.json]");
console.log(`  清理前任务: ${jobsBefore}`);
console.log(`  将删除(enabled=false 且未被引用的 once): ${jobsToDelete.length}`);
console.log(`  将保留: ${jobsToKeep.length}`);

if (!APPLY) {
  console.log("");
  console.log("dry-run：未写入任何文件。确认无误后加 --apply 执行。");
  process.exit(0);
}

// ---- 写入（先备份）----
if (existsSync(runsPath) && runsSkipped > 0) {
  const bak = backup(runsPath);
  writeFileSync(runsPath, keptLines.join("\n") + (keptLines.length ? "\n" : ""), "utf-8");
  console.log("");
  console.log(`已写入 runs（备份: ${bak}）`);
}
if (jobsPayload && jobsToDelete.length > 0) {
  const bak = backup(jobsPath);
  jobsPayload.jobs = jobsToKeep;
  writeFileSync(jobsPath, JSON.stringify(jobsPayload, null, 2), "utf-8");
  console.log(`已写入 jobs（备份: ${bak}）`);
}
console.log("完成。");
