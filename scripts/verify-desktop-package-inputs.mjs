import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TAURI_DIR = resolve(REPO_ROOT, "apps", "desktop", "src-tauri");
const TARGETS = {
  "aarch64-apple-darwin": "lume-sidecar-aarch64-apple-darwin",
  "x86_64-apple-darwin": "lume-sidecar-x86_64-apple-darwin",
  "x86_64-pc-windows-msvc": "lume-sidecar-x86_64-pc-windows-msvc.exe",
};
const REQUIRED_RESOURCES = ["resources/default-skills.tar", "binaries/lume-natives.node"];
const FORBIDDEN_RESOURCE_MARKERS = ["lume-sidecar.js", "sidecar-node-bridge", "node-modules"];

const target = process.env.TAURI_TARGET_TRIPLE;
const binaryName = TARGETS[target];
if (!binaryName) fail(`unsupported or missing TAURI_TARGET_TRIPLE: ${target ?? "(unset)"}`);

const requiredFiles = [
  resolve(TAURI_DIR, "binaries", binaryName),
  resolve(TAURI_DIR, "binaries", "lume-natives.node"),
  resolve(TAURI_DIR, "resources", "default-skills.tar"),
];
for (const file of requiredFiles) {
  if (!existsSync(file)) fail(`missing package input: ${file}`);
}

const config = JSON.parse(readFileSync(resolve(TAURI_DIR, "tauri.conf.json"), "utf8"));
const externalBin = config?.bundle?.externalBin ?? [];
const resources = config?.bundle?.resources ?? [];
if (JSON.stringify(externalBin) !== JSON.stringify(["binaries/lume-sidecar"])) {
  fail(`bundle.externalBin must be ["binaries/lume-sidecar"], got ${JSON.stringify(externalBin)}`);
}
for (const resource of REQUIRED_RESOURCES) {
  if (!resources.includes(resource)) fail(`bundle.resources missing ${resource}`);
}
for (const resource of resources) {
  if (FORBIDDEN_RESOURCE_MARKERS.some((marker) => resource.includes(marker))) {
    fail(`bundle.resources contains forbidden JS sidecar resource: ${resource}`);
  }
}

console.error(`[verify-package-inputs] ok for ${target}`);

function fail(message) {
  console.error(`[verify-package-inputs] ${message}`);
  process.exit(1);
}
