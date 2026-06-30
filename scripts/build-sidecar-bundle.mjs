import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SIDECAR_ENTRY = resolve(REPO_ROOT, "apps", "sidecar", "src", "index.ts");
const OUT_DIR = resolve(REPO_ROOT, "apps", "desktop", "resources", "sidecar");
const OUT_FILE = resolve(OUT_DIR, "index.mjs");

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

const args = [
  "build",
  SIDECAR_ENTRY,
  "--target=node",
  "--format=esm",
  `--outfile=${OUT_FILE}`,
];

console.error(`[sidecar-bundle] bun ${args.join(" ")}`);
const result = spawnSync("bun", args, { cwd: REPO_ROOT, stdio: "inherit" });
if (result.status !== 0) process.exit(result.status ?? 1);
if (!existsSync(OUT_FILE)) {
  console.error(`[sidecar-bundle] expected output not created: ${OUT_FILE}`);
  process.exit(1);
}
console.error(`[sidecar-bundle] wrote ${OUT_FILE}`);
