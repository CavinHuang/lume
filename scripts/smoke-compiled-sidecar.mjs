import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TARGETS = {
  "aarch64-apple-darwin": "lume-sidecar-aarch64-apple-darwin",
  "x86_64-apple-darwin": "lume-sidecar-x86_64-apple-darwin",
  "x86_64-pc-windows-msvc": "lume-sidecar-x86_64-pc-windows-msvc.exe",
};

const target = process.env.TAURI_TARGET_TRIPLE;
const binaryName = TARGETS[target];
if (!binaryName) fail(`unsupported or missing TAURI_TARGET_TRIPLE: ${target ?? "(unset)"}`);

const tauriDir = resolve(REPO_ROOT, "apps", "desktop", "src-tauri");
const sidecarPath = resolve(tauriDir, "binaries", binaryName);
const nativesPath = resolve(tauriDir, "binaries", "lume-natives.node");
const skillsArchive = resolve(tauriDir, "resources", "default-skills.tar");
for (const file of [sidecarPath, nativesPath, skillsArchive]) {
  if (!existsSync(file)) fail(`missing smoke input: ${file}`);
}

const configHome = mkdtempSync(join(tmpdir(), "lume-compiled-sidecar-smoke-"));
const smokeCwd = mkdtempSync(join(tmpdir(), "lume-compiled-sidecar-cwd-"));
const child = spawn(sidecarPath, [], {
  cwd: smokeCwd,
  env: {
    ...process.env,
    LUME_CONFIG_DIR: configHome,
    LUME_NATIVES_PATH: nativesPath,
    LUME_DEFAULT_SKILLS_ARCHIVE: skillsArchive,
    LUME_LOG_CONSOLE: "true",
  },
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});

let stdout = "";
let stderr = "";
let stdoutBuffer = "";
const timeout = setTimeout(() => {
  child.kill();
  cleanup();
  fail(`healthcheck timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`);
}, 15_000);

child.stdout.on("data", (chunk) => {
  const text = chunk.toString();
  stdout += text;
  stdoutBuffer += text;
  const lines = stdoutBuffer.split(/\r?\n/);
  stdoutBuffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id === 1) {
        clearTimeout(timeout);
        child.kill();
        cleanup();
        if (msg.error) fail(`healthcheck returned error: ${JSON.stringify(msg.error)}`);
        if (msg.result?.ok !== true) fail(`healthcheck returned unexpected result: ${JSON.stringify(msg.result)}`);
        console.error(`[smoke-compiled-sidecar] ok for ${target}`);
        process.exit(0);
      }
    } catch {
      // Non-JSON startup logs are allowed; the healthcheck response is JSON-RPC.
    }
  }
});

child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});
child.on("exit", (code, signal) => {
  clearTimeout(timeout);
  cleanup();
  fail(`sidecar exited before healthcheck (code=${code}, signal=${signal})\nstdout:\n${stdout}\nstderr:\n${stderr}`);
});

child.stdin.write(`${JSON.stringify({ id: 1, method: "healthcheck", params: null })}\n`);

function cleanup() {
  rmSync(configHome, { recursive: true, force: true });
  rmSync(smokeCwd, { recursive: true, force: true });
}

function fail(message) {
  console.error(`[smoke-compiled-sidecar] ${message}`);
  process.exit(1);
}
