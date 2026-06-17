import { copyFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NATIVES_DIR = resolve(REPO_ROOT, "packages", "natives");

const TARGETS = {
  "aarch64-apple-darwin": { cargoTarget: "aarch64-apple-darwin", suffix: "darwin-arm64" },
  "x86_64-apple-darwin": { cargoTarget: "x86_64-apple-darwin", suffix: "darwin-x64" },
  "x86_64-pc-windows-msvc": { cargoTarget: "x86_64-pc-windows-msvc", suffix: "win32-x64-msvc" },
  "x86_64-unknown-linux-gnu": { cargoTarget: "x86_64-unknown-linux-gnu", suffix: "linux-x64-gnu" },
  "aarch64-unknown-linux-gnu": { cargoTarget: "aarch64-unknown-linux-gnu", suffix: "linux-arm64-gnu" },
};

function parseTargetTriple() {
  const explicitIndex = process.argv.indexOf("--tauri-target");
  if (explicitIndex >= 0 && process.argv[explicitIndex + 1]) {
    return process.argv[explicitIndex + 1];
  }
  if (process.env.TAURI_TARGET_TRIPLE) return process.env.TAURI_TARGET_TRIPLE;
  if (process.platform === "darwin" && process.arch === "arm64") return "aarch64-apple-darwin";
  if (process.platform === "darwin") return "x86_64-apple-darwin";
  if (process.platform === "win32") return "x86_64-pc-windows-msvc";
  if (process.platform === "linux" && process.arch === "arm64") return "aarch64-unknown-linux-gnu";
  return "x86_64-unknown-linux-gnu";
}

const targetTriple = parseTargetTriple();
const target = TARGETS[targetTriple];
if (!target) {
  console.error(`[natives-binary] unsupported Tauri target: ${targetTriple}`);
  process.exit(1);
}

const outfile = resolve(REPO_ROOT, "apps", "desktop", "src-tauri", "binaries", "lume-natives.node");
mkdirSync(dirname(outfile), { recursive: true });

const manifestPath = resolve(NATIVES_DIR, "..", "..", "crates", "lume-natives", "Cargo.toml");
const searchDir = resolve(NATIVES_DIR, "..", "..", "crates", "lume-natives", "target", target.cargoTarget, "release");

console.error(`[natives-binary] cargo build --target ${target.cargoTarget} ...`);
const result = spawnSync("cargo", [
  "build",
  "--release",
  "--manifest-path",
  manifestPath,
  "--target",
  target.cargoTarget,
], { cwd: REPO_ROOT, stdio: "inherit" });

if (result.status !== 0) {
  console.error(`[natives-binary] failed (status=${result.status})`);
  process.exit(1);
}

const nativeLibrary = findNativeLibrary(searchDir);
if (!nativeLibrary) {
  console.error(`[natives-binary] failed to find built library in ${searchDir}`);
  process.exit(1);
}

copyFileSync(nativeLibrary, outfile);
console.error("COPIED_OK");
console.error(`[natives-binary] wrote ${outfile}`);

function findNativeLibrary(dir) {
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      const nested = findNativeLibrary(fullPath);
      if (nested) return nested;
      continue;
    }
    if (
      stats.isFile() &&
      (
        /^liblume_natives.*\.dylib$/.test(entry) ||
        /^lume_natives.*\.so$/.test(entry) ||
        /^lume_natives.*\.dll$/.test(entry)
      )
    ) {
      return fullPath;
    }
  }
  return null;
}
