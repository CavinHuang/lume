import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const electronBuilderBin = process.platform === "win32"
  ? resolve(desktopRoot, "node_modules", ".bin", "electron-builder.exe")
  : resolve(desktopRoot, "node_modules", ".bin", "electron-builder");
const fsRetryHook = resolve(desktopRoot, "scripts", "fs-retry.cjs");
const rawArgs = process.argv.slice(2);
const outputArgIndex = rawArgs.indexOf("--output-dir");
const outputDir = outputArgIndex >= 0 && rawArgs[outputArgIndex + 1]
  ? rawArgs[outputArgIndex + 1]
  : "dist-package";
let electronBuilderArgs = outputArgIndex >= 0
  ? rawArgs.filter((_, index) => index !== outputArgIndex && index !== outputArgIndex + 1)
  : rawArgs;
let effectiveOutputDir = outputDir;
let distDir = resolve(desktopRoot, effectiveOutputDir);

try {
  rmSync(distDir, { recursive: true, force: true });
} catch (error) {
  if (error?.code !== "EBUSY" && error?.code !== "EPERM") {
    throw error;
  }
  effectiveOutputDir = `${outputDir}-${Date.now()}`;
  distDir = resolve(desktopRoot, effectiveOutputDir);
  electronBuilderArgs = electronBuilderArgs.map((arg) => (
    arg === `--config.directories.output=${outputDir}`
      ? `--config.directories.output=${effectiveOutputDir}`
      : arg
  ));
}

const child = spawn(electronBuilderBin, electronBuilderArgs, {
  cwd: desktopRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    ELECTRON_MIRROR: process.env.ELECTRON_MIRROR?.trim() || "https://npmmirror.com/mirrors/electron/",
    NODE_OPTIONS: [
      process.env.NODE_OPTIONS?.trim(),
      `--require=${fsRetryHook}`,
    ].filter(Boolean).join(" "),
  },
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
