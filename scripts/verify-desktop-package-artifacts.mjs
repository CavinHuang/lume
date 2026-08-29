import { appendFileSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import asar from "asar";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DESKTOP_DIR = resolve(REPO_ROOT, "apps", "desktop");
const target = process.env.LUME_DESKTOP_TARGET ?? currentDesktopTarget();

const required = {
  "aarch64-apple-darwin": [/\.dmg$/i, /latest-mac\.yml$/i],
  "x86_64-apple-darwin": [/\.dmg$/i, /latest-mac\.yml$/i],
  "x86_64-pc-windows-msvc": [/\.exe$/i, /\.blockmap$/i, /latest\.yml$/i],
  "x86_64-unknown-linux-gnu": [/\.AppImage$/i, /latest-linux\.yml$/i],
  "aarch64-unknown-linux-gnu": [/\.AppImage$/i, /latest-linux\.yml$/i],
};
const targetArtifactPatterns = {
  "aarch64-apple-darwin": [/\.dmg$/i, /(?:aarch64|arm64)/i],
  "x86_64-apple-darwin": [/\.dmg$/i, /(?:x86_64|x64)/i],
};

if (!required[target]) fail(`unsupported desktop target: ${target ?? "(unset)"}`);

const { outputDir, files } = findArtifactOutput(required[target]);
const targetSpecific = targetArtifactPatterns[target];
if (targetSpecific && !files.some((file) => targetSpecific.every((pattern) => pattern.test(file)))) {
  fail(`missing target-specific artifact for ${target} under ${outputDir}`);
}
verifyPackagedApplications(files);
verifyNativeResources(files, target);
verifyRipgrepResources(files, target);
verifyOfficeCliResources(files, target);
verifySidecarResources(files, target);

writeSummary(`Local Electron package artifacts for ${target}`, files);
console.error(`[verify-package-artifacts] ok for ${target}`);

function currentDesktopTarget() {
  if (process.platform === "darwin" && process.arch === "arm64") return "aarch64-apple-darwin";
  if (process.platform === "darwin") return "x86_64-apple-darwin";
  if (process.platform === "win32") return "x86_64-pc-windows-msvc";
  if (process.platform === "linux" && process.arch === "arm64") return "aarch64-unknown-linux-gnu";
  return "x86_64-unknown-linux-gnu";
}

function walk(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
    } else {
      out.push(toPosix(full));
    }
  }
  return out;
}

function findArtifactOutput(patterns) {
  const failures = [];
  for (const candidate of outputCandidates()) {
    const candidateFiles = walk(candidate).filter((file) => !/builder-debug\.yml$/i.test(file));
    const missing = patterns.filter((pattern) => !candidateFiles.some((file) => pattern.test(file)));
    if (missing.length === 0) return { outputDir: candidate, files: candidateFiles };
    failures.push(`${candidate} missing ${missing.map(String).join(", ")}`);
  }
  fail(`missing Electron package artifacts. Checked: ${failures.join("; ")}`);
}

function outputCandidates() {
  const configured = process.env.LUME_DESKTOP_OUTPUT_DIR;
  if (configured) return [resolve(DESKTOP_DIR, configured)];

  const baseName = "dist-release";
  const prefix = `${baseName}-`;
  const candidates = readdirSync(DESKTOP_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && (entry.name === baseName || entry.name.startsWith(prefix)))
    .map((entry) => {
      const dir = resolve(DESKTOP_DIR, entry.name);
      return { dir, mtimeMs: statSync(dir).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map((entry) => entry.dir);

  return candidates.length > 0 ? candidates : [resolve(DESKTOP_DIR, baseName)];
}

function toPosix(file) {
  return file.replaceAll("\\", "/");
}

function verifyPackagedApplications(files) {
  const archives = files.filter((file) => /\/resources\/app\.asar$/i.test(file));
  if (archives.length === 0) fail("packaged application app.asar is missing");

  const requiredEntries = ["/dist/main/main.mjs", "/dist/preload/preload.cjs", "/assets/icon.png"];
  for (const archive of archives) {
    const entries = asar.listPackage(archive).map(toPosix);
    for (const requiredEntry of requiredEntries) {
      if (!entries.includes(requiredEntry)) {
        fail(`${archive} missing ${requiredEntry}`);
      }
    }
    if (entries.some((entry) => entry.startsWith("/src") || entry.startsWith("/node_modules"))) {
      fail(`${archive} must contain only bundled main-process runtime files`);
    }
    if (entries.some((entry) => entry.endsWith(".node"))) {
      fail(`${archive} must not contain native .node binaries`);
    }
  }
}

function verifyNativeResources(files, desktopTarget) {
  const requiredTargets = desktopTarget.includes("apple-darwin")
    ? ["darwin-arm64", "darwin-x64"]
    : [nativeResourceTarget(desktopTarget)];

  for (const nativeTarget of requiredTargets) {
    const pattern = new RegExp(`/resources/natives/${nativeTarget}/lume-natives\\.node$`, "i");
    if (!files.some((file) => pattern.test(file))) {
      fail(`missing native resource for ${nativeTarget}`);
    }
  }
}

function verifyRipgrepResources(files, desktopTarget) {
  const nativeTarget = nativeResourceTarget(desktopTarget);
  const binary = desktopTarget === "x86_64-pc-windows-msvc" ? "rg\\.exe" : "rg";
  const pattern = new RegExp(`/resources/ripgrep/${nativeTarget}/${binary}$`, "i");
  if (!files.some((file) => pattern.test(file))) {
    fail(`missing bundled ripgrep resource for ${nativeTarget}`);
  }
}

// officecli 目录 id 是平台-arch（win32-x64 而非 win32-x64-msvc），与 after-pack
// 的按 arch 修剪对应：每个安装包只含自身 arch 的二进制。
function verifyOfficeCliResources(files, desktopTarget) {
  const target = desktopTarget === "x86_64-pc-windows-msvc" ? "win32-x64" : nativeResourceTarget(desktopTarget);
  const binary = desktopTarget === "x86_64-pc-windows-msvc" ? "officecli\\.exe" : "officecli";
  const pattern = new RegExp(`/resources/officecli/${target}/${binary}$`, "i");
  if (!files.some((file) => pattern.test(file))) {
    fail(`missing bundled officecli resource for ${target}`);
  }
}

function verifySidecarResources(files, desktopTarget) {
  for (const name of ["index.mjs", "xhr-sync-worker.mjs", "local-embedding-worker.mjs"]) {
    const pattern = new RegExp(`/resources/sidecar/${name.replace(".", "\\.")}$`, "i");
    if (!files.some((file) => pattern.test(file))) {
      fail(`missing packaged sidecar resource: ${name}`);
    }
  }
  const onnxRuntimeNative = files.find((file) => /\/resources\/bin\/napi-v3\/[^/]+\/[^/]+\/onnxruntime_binding\.node$/i.test(file));
  if (!onnxRuntimeNative) fail("missing packaged ONNX Runtime native binding");
  const sharpNative = files.find((file) => /\/resources\/sidecar\/node_modules\/@img\/sharp-[^/]+\/lib\/sharp-[^/]+\.node$/i.test(file));
  if (!sharpNative) fail("missing packaged sharp native binding");
  const skillsArchive = files.find((file) => /\/resources\/default-skills\.tar$/i.test(file));
  if (!skillsArchive) fail("missing packaged default-skills.tar");
  if (desktopTarget === "x86_64-pc-windows-msvc") {
    const windowsSandbox = /\/resources\/sidecar\/node_modules\/@microsoft\/mxc-sdk\/bin\/x64\/wxc-exec\.exe$/i;
    if (!files.some((file) => windowsSandbox.test(file))) {
      fail("missing packaged Windows MXC sandbox runtime");
    }
  }
}

function nativeResourceTarget(desktopTarget) {
  const map = {
    "x86_64-pc-windows-msvc": "win32-x64-msvc",
    "x86_64-unknown-linux-gnu": "linux-x64-gnu",
    "aarch64-unknown-linux-gnu": "linux-arm64-gnu",
    "aarch64-apple-darwin": "darwin-arm64",
    "x86_64-apple-darwin": "darwin-x64",
  };
  const resourceTarget = map[desktopTarget];
  if (!resourceTarget) fail(`unsupported native resource target: ${desktopTarget}`);
  return resourceTarget;
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
