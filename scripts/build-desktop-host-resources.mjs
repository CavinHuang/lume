import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CRATE_DIR = resolve(REPO_ROOT, "crates", "lume-desktop-host");
const CRATE_MANIFEST = resolve(CRATE_DIR, "Cargo.toml");
const TARGET_ID = resolveTargetId(process.platform, process.arch);
const BINARY_NAME = process.platform === "win32" ? "lume_desktop_host.exe" : "lume_desktop_host";
const BUILT_BINARY = resolve(CRATE_DIR, "target", "release", BINARY_NAME);
const OUT_DIR = resolve(REPO_ROOT, "apps", "desktop", "resources", "desktop-host", TARGET_ID);
const OUT_FILE = resolve(OUT_DIR, BINARY_NAME);

const result = spawnSync("cargo", [
  "build",
  "--release",
  "--locked",
  "--manifest-path",
  CRATE_MANIFEST,
], { cwd: REPO_ROOT, stdio: "inherit" });
if (result.status !== 0) process.exit(result.status ?? 1);
if (!existsSync(BUILT_BINARY)) {
  console.error(`[desktop-host] expected output not created: ${BUILT_BINARY}`);
  process.exit(1);
}

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });
copyFileSync(BUILT_BINARY, OUT_FILE);
console.error(`[desktop-host] wrote ${OUT_FILE}`);

function resolveTargetId(platform, arch) {
  if (platform === "win32" && arch === "x64") return "win32-x64-msvc";
  if (platform === "darwin" && arch === "x64") return "darwin-x64";
  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  throw new Error(`unsupported desktop host target: ${platform}-${arch}`);
}
