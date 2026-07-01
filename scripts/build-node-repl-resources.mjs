import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = resolve(REPO_ROOT, "apps", "desktop", "resources-src", "node-repl");
const OUT_DIR = resolve(REPO_ROOT, "apps", "desktop", "resources", "node-repl");

if (!existsSync(SRC_DIR)) {
  console.error(`[node-repl-resources] missing source directory: ${SRC_DIR}`);
  process.exit(1);
}

rmSync(OUT_DIR, { recursive: true, force: true });
cpSync(SRC_DIR, OUT_DIR, { recursive: true });
console.error(`[node-repl-resources] copied ${SRC_DIR} to ${OUT_DIR}`);
await import("./build-node-repl-host.mjs");
