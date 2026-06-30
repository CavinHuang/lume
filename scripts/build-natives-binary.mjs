import { copyFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CRATE_MANIFEST = resolve(REPO_ROOT, "crates", "lume-natives", "Cargo.toml");
const DESKTOP_NATIVES_DIR = resolve(REPO_ROOT, "apps", "desktop", "resources", "natives");
const PACKAGE_DIST_DIR = resolve(REPO_ROOT, "packages", "natives", "dist");
const NATIVE_BINARY_NAME = "lume-natives.node";

const TARGETS = {
  "darwin-arm64": { cargoTarget: "aarch64-apple-darwin", suffix: "darwin-arm64" },
  "darwin-x64": { cargoTarget: "x86_64-apple-darwin", suffix: "darwin-x64" },
  "win32-x64-msvc": { cargoTarget: "x86_64-pc-windows-msvc", suffix: "win32-x64-msvc" },
  "linux-x64-gnu": { cargoTarget: "x86_64-unknown-linux-gnu", suffix: "linux-x64-gnu" },
  "linux-arm64-gnu": { cargoTarget: "aarch64-unknown-linux-gnu", suffix: "linux-arm64-gnu" },
};

const TARGET_ALIASES = Object.fromEntries(
  Object.values(TARGETS).map((target) => [target.cargoTarget, target.suffix]),
);

function parseOptionValue(names) {
  for (const name of names) {
    const index = process.argv.indexOf(name);
    if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
    const prefix = `${name}=`;
    const match = process.argv.find((arg) => arg.startsWith(prefix));
    if (match) return match.slice(prefix.length);
  }
  return null;
}

function currentTargetId() {
  if (process.platform === "darwin" && process.arch === "arm64") return "darwin-arm64";
  if (process.platform === "darwin" && process.arch === "x64") return "darwin-x64";
  if (process.platform === "win32" && process.arch === "x64") return "win32-x64-msvc";
  if (process.platform === "linux" && process.arch === "arm64") return "linux-arm64-gnu";
  if (process.platform === "linux" && process.arch === "x64") return "linux-x64-gnu";
  throw new Error(`unsupported native target: ${process.platform}-${process.arch}`);
}

function parseTargetId() {
  const explicit = parseOptionValue(["--target", "--desktop-target", "--tauri-target"]);
  const target = explicit
    ?? process.env.LUME_NATIVE_TARGET
    ?? process.env.LUME_DESKTOP_TARGET
    ?? process.env.TAURI_TARGET_TRIPLE
    ?? currentTargetId();
  return TARGET_ALIASES[target] ?? target;
}

const targetId = parseTargetId();
const target = TARGETS[targetId];
if (!target) {
  console.error(`[natives-binary] unsupported target: ${targetId}`);
  process.exit(1);
}

const targetDir = resolve(REPO_ROOT, "crates", "lume-natives", "target", target.cargoTarget, "release");
const desktopOutfile = resolve(DESKTOP_NATIVES_DIR, target.suffix, NATIVE_BINARY_NAME);
const packageOutfile = resolve(PACKAGE_DIST_DIR, `lume-natives.${target.suffix}.node`);

mkdirSync(dirname(desktopOutfile), { recursive: true });
mkdirSync(dirname(packageOutfile), { recursive: true });

const args = [
  "build",
  "--release",
  "--locked",
  "--manifest-path",
  CRATE_MANIFEST,
  "--target",
  target.cargoTarget,
];

console.error(`[natives-binary] cargo ${args.join(" ")}`);
const result = spawnSync("cargo", args, { cwd: REPO_ROOT, stdio: "inherit" });

if (result.status !== 0) {
  console.error(`[natives-binary] failed (status=${result.status})`);
  process.exit(result.status ?? 1);
}

const nativeLibrary = findNativeLibrary(targetDir);
if (!nativeLibrary) {
  console.error(`[natives-binary] failed to find built library in ${targetDir}`);
  process.exit(1);
}

copyFileSync(nativeLibrary, desktopOutfile);
copyFileSync(nativeLibrary, packageOutfile);
console.error(`[natives-binary] wrote ${desktopOutfile}`);
console.error(`[natives-binary] wrote ${packageOutfile}`);

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
      stats.isFile()
      && (
        /^liblume_natives.*\.dylib$/.test(entry)
        || /^liblume_natives.*\.so$/.test(entry)
        || /^lume_natives.*\.dll$/.test(entry)
      )
    ) {
      return fullPath;
    }
  }
  return null;
}
