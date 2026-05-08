import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildMacSidecarCommand } from "./sidecar-runtime.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(scriptDir, "..");
const repoRoot = resolve(desktopDir, "..", "..");
const sidecarDir = resolve(repoRoot, "apps", "sidecar");
const packagesDir = resolve(repoRoot, "packages");
const tauriBin = process.platform === "win32"
  ? resolve(repoRoot, "node_modules", ".bin", "tauri.exe")
  : resolve(repoRoot, "node_modules", ".bin", "tauri");
const bunBin = process.env.LUME_SIDECAR_BUN || resolve(process.env.HOME ?? "", ".volta/tools/image/packages/bun/bin/bun");
const nodeBin = process.env.LUME_SIDECAR_NODE || process.execPath;
const echoSidecarPath = resolve(scriptDir, "sidecar-echo-repro.js");
const bridgePath = resolve(scriptDir, "sidecar-node-bridge.mjs");

const env = { ...process.env };
const restartDebounceMs = 250;
const watchedFiles = new Set([
  resolve(repoRoot, "package.json"),
  resolve(repoRoot, "bun.lock"),
  resolve(repoRoot, "bun.lockb"),
  resolve(sidecarDir, "package.json")
]);
const watchedDirectories = [
  { path: resolve(sidecarDir, "src"), label: "sidecar" },
  { path: packagesDir, label: "packages" }
];

let child = null;
let isStopping = false;
let pendingRestart = false;
let restartTimer = null;

if (process.platform === "darwin") {
  env.LUME_SIDECAR_PREFER_ENV ||= "1";
  if (!env.LUME_SIDECAR_CMD) {
    const sidecarCmd = buildMacSidecarCommand({
      nodeBin,
      bunBin,
      sidecarDir,
      entry: env.LUME_SIDECAR_ECHO_REPRO === "1" ? echoSidecarPath : "src/index.ts",
      bridgePath,
      echoMode: env.LUME_SIDECAR_ECHO_REPRO === "1"
    });
    env.LUME_SIDECAR_CMD = sidecarCmd;
  }
}

function log(message) {
  console.log(`[desktop-dev] ${message}`);
}

function spawnDesktopProcess() {
  child = spawn(tauriBin, ["dev", "--config", "src-tauri/tauri.dev.conf.json"], {
    cwd: desktopDir,
    env,
    stdio: "inherit",
    shell: false,
    windowsHide: false
  });

  child.on("exit", (code, signal) => {
    const restarting = pendingRestart;
    child = null;
    pendingRestart = false;

    if (isStopping) {
      process.exit(code ?? 0);
      return;
    }

    if (restarting) {
      log("检测到 sidecar/package 变更，正在重启 desktop dev...");
      spawnDesktopProcess();
      return;
    }

    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

function killChildTree(target) {
  if (!target || target.killed) return;

  if (process.platform === "win32" && typeof target.pid === "number") {
    const killer = spawn("taskkill", ["/pid", String(target.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true
    });
    killer.on("error", () => {
      try {
        target.kill("SIGTERM");
      } catch {}
    });
    return;
  }

  try {
    target.kill("SIGTERM");
  } catch {}
}

function requestRestart(reason) {
  if (isStopping) return;
  if (restartTimer) {
    clearTimeout(restartTimer);
  }
  restartTimer = setTimeout(() => {
    restartTimer = null;
    if (!child) {
      log(`检测到 ${reason} 变化，启动 desktop dev...`);
      spawnDesktopProcess();
      return;
    }
    if (pendingRestart) return;
    pendingRestart = true;
    log(`检测到 ${reason} 变化，准备重启 desktop dev...`);
    killChildTree(child);
  }, restartDebounceMs);
}

function startWatchers() {
  const watchers = [];

  for (const filePath of watchedFiles) {
    try {
      const watcher = watch(filePath, () => {
        requestRestart(filePath.replace(`${repoRoot}\\`, ""));
      });
      watchers.push(watcher);
    } catch (error) {
      log(`watch 文件失败: ${filePath} (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  for (const entry of watchedDirectories) {
    try {
      const watcher = watch(entry.path, { recursive: true }, (_eventType, filename) => {
        if (!filename) {
          requestRestart(entry.label);
          return;
        }
        const normalized = String(filename).replaceAll("/", "\\");
        if (normalized.includes("\\node_modules\\")) return;
        if (normalized.includes("\\dist\\")) return;
        if (normalized.includes("\\target\\")) return;
        requestRestart(`${entry.label}/${normalized}`);
      });
      watchers.push(watcher);
    } catch (error) {
      log(`watch 目录失败: ${entry.path} (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  return watchers;
}

const watchers = startWatchers();
spawnDesktopProcess();

function shutdown(signal) {
  isStopping = true;
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  for (const watcher of watchers) {
    watcher.close();
  }
  if (!child) {
    process.exit(0);
    return;
  }
  child.once("exit", () => {
      process.exit(0);
  });
  killChildTree(child);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => shutdown(signal));
}
