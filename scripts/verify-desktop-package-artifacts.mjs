import { existsSync, readdirSync, appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = process.env.TAURI_TARGET_TRIPLE;
const roots = {
  "aarch64-apple-darwin": resolve(REPO_ROOT, "apps/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle"),
  "x86_64-apple-darwin": resolve(REPO_ROOT, "apps/desktop/src-tauri/target/x86_64-apple-darwin/release/bundle"),
  "x86_64-pc-windows-msvc": resolve(REPO_ROOT, "apps/desktop/src-tauri/target/release/bundle"),
};
const required = {
  "aarch64-apple-darwin": [/\/macos\/.*\.app$/, /\/macos\/.*\.app\/Contents\/MacOS\/lume-sidecar$/, /\/macos\/.*\.app\.tar\.gz$/, /\/macos\/.*\.app\.tar\.gz\.sig$/, /\/dmg\/.*\.dmg$/],
  "x86_64-apple-darwin": [/\/macos\/.*\.app$/, /\/macos\/.*\.app\/Contents\/MacOS\/lume-sidecar$/, /\/macos\/.*\.app\.tar\.gz$/, /\/macos\/.*\.app\.tar\.gz\.sig$/, /\/dmg\/.*\.dmg$/],
  "x86_64-pc-windows-msvc": [/\/nsis\/.*\.exe$/, /\/nsis\/.*\.exe\.sig$/],
};

const root = roots[target];
if (!root) fail(`unsupported or missing TAURI_TARGET_TRIPLE: ${target ?? "(unset)"}`);
const files = walk(root);
for (const pattern of required[target]) {
  if (!files.some((file) => pattern.test(file))) fail(`missing artifact matching ${pattern} under ${root}`);
}
writeSummary(`Local package artifacts for ${target}`, files);
console.error(`[verify-package-artifacts] ok for ${target}`);

function walk(dir) {
  if (!existsSync(dir)) fail(`bundle directory missing: ${dir}`);
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(toPosix(full));
      out.push(...walk(full));
    } else {
      out.push(toPosix(full));
    }
  }
  return out;
}

function toPosix(file) {
  return file.replaceAll("\\", "/");
}

function writeSummary(title, files) {
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (!summary) return;
  appendFileSync(summary, `\n### ${title}\n` + files.map((file) => `- ${file}`).join("\n") + "\n");
}

function fail(message) {
  console.error(`[verify-package-artifacts] ${message}`);
  process.exit(1);
}
