import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SIDECAR_ENTRY = resolve(REPO_ROOT, "apps", "sidecar", "src", "index.ts");
const OUT_BASE = resolve(REPO_ROOT, "apps", "desktop", "src-tauri", "binaries", "lume-sidecar");

const TARGETS = {
  "aarch64-apple-darwin": {
    bunTarget: "bun-darwin-arm64",
    suffix: "aarch64-apple-darwin",
  },
  "x86_64-apple-darwin": {
    bunTarget: "bun-darwin-x64",
    suffix: "x86_64-apple-darwin",
  },
  "x86_64-pc-windows-msvc": {
    bunTarget: "bun-windows-x64",
    suffix: "x86_64-pc-windows-msvc.exe",
    windows: true,
  },
  "x86_64-unknown-linux-gnu": {
    bunTarget: "bun-linux-x64",
    suffix: "x86_64-unknown-linux-gnu",
  },
  "aarch64-unknown-linux-gnu": {
    bunTarget: "bun-linux-arm64",
    suffix: "aarch64-unknown-linux-gnu",
  },
};

function parseTargetTriple() {
  const explicitIndex = process.argv.indexOf("--tauri-target");
  if (explicitIndex >= 0 && process.argv[explicitIndex + 1]) {
    return process.argv[explicitIndex + 1];
  }
  if (process.env.TAURI_TARGET_TRIPLE) {
    return process.env.TAURI_TARGET_TRIPLE;
  }

  if (process.platform === "darwin" && process.arch === "arm64") {
    return "aarch64-apple-darwin";
  }
  if (process.platform === "darwin") {
    return "x86_64-apple-darwin";
  }
  if (process.platform === "win32") {
    return "x86_64-pc-windows-msvc";
  }
  if (process.platform === "linux" && process.arch === "arm64") {
    return "aarch64-unknown-linux-gnu";
  }
  return "x86_64-unknown-linux-gnu";
}

const targetTriple = parseTargetTriple();
const target = TARGETS[targetTriple];
if (!target) {
  console.error(`[sidecar-binary] unsupported Tauri target: ${targetTriple}`);
  process.exit(1);
}

const outfile = `${OUT_BASE}-${target.suffix}`;
mkdirSync(dirname(outfile), { recursive: true });

const args = [
  "build",
  SIDECAR_ENTRY,
  "--compile",
  `--target=${target.bunTarget}`,
  `--outfile=${outfile}`,
];

if (target.windows) {
  args.push("--windows-hide-console");
  args.push("--windows-title=Lume Sidecar");
}

console.error(`[sidecar-binary] bun ${args.join(" ")}`);
const result = spawnSync("bun", args, {
  cwd: REPO_ROOT,
  stdio: "inherit",
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

if (!target.windows) {
  chmodSync(outfile, 0o755);
}

console.error(`[sidecar-binary] wrote ${outfile}`);
