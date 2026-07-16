import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import {
  ensureElectronRuntimeInstalled,
  resolveElectronPackageRoot,
} from "../apps/desktop/scripts/electron-runtime.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DESKTOP_DIR = resolve(REPO_ROOT, "apps", "desktop");
const sidecarPath = resolve(DESKTOP_DIR, "resources", "sidecar", "index.mjs");
const xhrWorkerPath = resolve(DESKTOP_DIR, "resources", "sidecar", "xhr-sync-worker.mjs");
const skillsArchive = resolve(DESKTOP_DIR, "resources", "default-skills.tar");
const nativeBinary = resolve(DESKTOP_DIR, "resources", "natives", currentNativeTargetId(), "lume-natives.node");
const sidecarSmokeEntry = resolve(DESKTOP_DIR, "scripts", "smoke-utility-sidecar.mjs");
const nativeSmokeEntry = resolve(DESKTOP_DIR, "scripts", "smoke-utility-natives.mjs");

for (const file of [sidecarPath, xhrWorkerPath, skillsArchive, nativeBinary, sidecarSmokeEntry, nativeSmokeEntry]) {
  if (!existsSync(file)) fail(`missing smoke input: ${file}`);
}

const escapedRepoRoot = JSON.stringify(REPO_ROOT).slice(1, -1).toLowerCase();
for (const file of [sidecarPath, xhrWorkerPath]) {
  const source = readFileSync(file, "utf8");
  if (source.toLowerCase().includes(escapedRepoRoot)) {
    fail(`${file} contains the build workspace path`);
  }
  if (source.includes("default-stylesheet.css")) {
    fail(`${file} still reads jsdom's default stylesheet from disk`);
  }
}

const electronPackageRoot = resolveElectronPackageRoot(pathToFileURL(sidecarSmokeEntry).href);
const electronExecutable = await ensureElectronRuntimeInstalled({
  electronPackageRoot,
  log: (message) => console.error(`[smoke-sidecar-bundle] ${message}`),
});
const configHome = mkdtempSync(join(tmpdir(), "lume-sidecar-bundle-smoke-"));
const smokeCwd = mkdtempSync(join(tmpdir(), "lume-sidecar-bundle-cwd-"));
const relocatedRoot = mkdtempSync(join(tmpdir(), "lume-sidecar-relocated-"));
const relocatedResourcesDir = resolve(relocatedRoot, "resources");
const relocatedSidecarDir = resolve(relocatedResourcesDir, "sidecar");
const relocatedNative = resolve(relocatedResourcesDir, "natives", currentNativeTargetId(), "lume-natives.node");
mkdirSync(dirname(relocatedNative), { recursive: true });
cpSync(dirname(sidecarPath), relocatedSidecarDir, { recursive: true });
cpSync(resolve(DESKTOP_DIR, "resources", "data"), resolve(relocatedResourcesDir, "data"), { recursive: true });
cpSync(resolve(DESKTOP_DIR, "resources", "package.json"), resolve(relocatedResourcesDir, "package.json"));
cpSync(nativeBinary, relocatedNative);
cpSync(skillsArchive, resolve(relocatedResourcesDir, "default-skills.tar"));

try {
  runElectronSmoke("native utility", nativeSmokeEntry, {
    LUME_NATIVES_PATH: relocatedNative,
  });
  runElectronSmoke("sidecar bundle", sidecarSmokeEntry, {
    LUME_SIDECAR_BUNDLE: resolve(relocatedSidecarDir, "index.mjs"),
    LUME_XHR_SYNC_WORKER: resolve(relocatedSidecarDir, "xhr-sync-worker.mjs"),
    LUME_NATIVES_PATH: relocatedNative,
    LUME_CONFIG_DIR: configHome,
    LUME_DEFAULT_SKILLS_ARCHIVE: resolve(relocatedResourcesDir, "default-skills.tar"),
    LUME_LOG_CONSOLE: "true",
  });
  console.error("[smoke-sidecar-bundle] ok via Electron utilityProcess");
} finally {
  rmSync(configHome, { recursive: true, force: true });
  rmSync(smokeCwd, { recursive: true, force: true });
  rmSync(relocatedRoot, { recursive: true, force: true });
}

function runElectronSmoke(label, entry, extraEnv) {
  const result = spawnSync(electronExecutable, [entry], {
    cwd: smokeCwd,
    env: {
      ...process.env,
      ...extraEnv,
    },
    encoding: "utf8",
    timeout: 25_000,
    windowsHide: true,
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) fail(`${label}: ${result.error.stack ?? result.error.message}`);
  if (result.status !== 0) fail(`${label}: Electron smoke exited with code ${result.status}`);
}

function currentNativeTargetId() {
  if (process.platform === "darwin" && process.arch === "arm64") return "darwin-arm64";
  if (process.platform === "darwin" && process.arch === "x64") return "darwin-x64";
  if (process.platform === "win32" && process.arch === "x64") return "win32-x64-msvc";
  if (process.platform === "linux" && process.arch === "arm64") return "linux-arm64-gnu";
  if (process.platform === "linux" && process.arch === "x64") return "linux-x64-gnu";
  fail(`unsupported native target: ${process.platform}-${process.arch}`);
}

function fail(message) {
  console.error(`[smoke-sidecar-bundle] ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}
