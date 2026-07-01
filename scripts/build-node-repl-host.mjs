import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CRATE_DIR = resolve(REPO_ROOT, "crates", "lume-node-repl-host");
const CRATE_MANIFEST = resolve(CRATE_DIR, "Cargo.toml");
const OUT_DIR = resolve(REPO_ROOT, "apps", "desktop", "resources", "node-repl", "bin");
const BINARY_NAME = process.platform === "win32" ? "node_repl.exe" : "node_repl";
const BUILT_BINARY = resolve(CRATE_DIR, "target", "release", BINARY_NAME);
const OUT_FILE = resolve(OUT_DIR, BINARY_NAME);

mkdirSync(OUT_DIR, { recursive: true });

const args = [
  "build",
  "--release",
  "--locked",
  "--manifest-path",
  CRATE_MANIFEST,
];

console.error(`[node-repl-host] cargo ${args.join(" ")}`);
const result = spawnSync("cargo", args, { cwd: REPO_ROOT, stdio: "inherit" });
if (result.status !== 0) process.exit(result.status ?? 1);
if (!existsSync(BUILT_BINARY)) {
  console.error(`[node-repl-host] expected output not created: ${BUILT_BINARY}`);
  process.exit(1);
}

copyFileSync(BUILT_BINARY, OUT_FILE);
console.error(`[node-repl-host] wrote ${OUT_FILE}`);
