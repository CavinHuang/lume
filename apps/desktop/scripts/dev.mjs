import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildMacSidecarCommand } from "./sidecar-runtime.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(scriptDir, "..");
const repoRoot = resolve(desktopDir, "..", "..");
const sidecarDir = resolve(repoRoot, "apps", "sidecar");
const bunBin = process.env.LUME_SIDECAR_BUN || resolve(process.env.HOME ?? "", ".volta/tools/image/packages/bun/bin/bun");
const nodeBin = process.env.LUME_SIDECAR_NODE || process.execPath;
const echoSidecarPath = resolve(scriptDir, "sidecar-echo-repro.js");
const bridgePath = resolve(scriptDir, "sidecar-node-bridge.mjs");

const env = { ...process.env };

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

const child = spawn("tauri", ["dev"], {
  cwd: desktopDir,
  env,
  stdio: "inherit",
  shell: process.platform === "win32"
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
