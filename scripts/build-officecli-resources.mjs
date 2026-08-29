import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// OfficeCLI 是 Office 高保真预览的外部渲染器（docx/xlsx/pptx → 独立 HTML），
// 随安装包分发。每次构建按目标平台从官方 GitHub Release 取固定版本，
// 精确字节数 + SHA-256 双重校验后原子写入；产物目录被 .gitignore 覆盖。
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_ROOT = resolve(REPO_ROOT, "apps", "desktop", "resources", "officecli");
const VERSION = "v1.0.145";
const RELEASE_ROOT = `https://github.com/iOfficeAI/OfficeCLI/releases/download/${VERSION}`;
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;

const TARGETS = {
  "darwin-arm64": {
    asset: "officecli-mac-arm64",
    sha256: "d66763a563bc844c3cc67036ebc7c4a9caa9319b9592814d9acd3706da231fc1",
    sizeBytes: 33_764_912,
    executable: "officecli",
  },
  "darwin-x64": {
    asset: "officecli-mac-x64",
    sha256: "d7dc7013f7bf0af6345ae16a7913e6cf041947460d7f2fa3e024f0b27073d0a2",
    sizeBytes: 34_708_640,
    executable: "officecli",
  },
  "linux-arm64": {
    asset: "officecli-linux-arm64",
    sha256: "d38233bb7df4f0f5fb40313de1f00c0f0e575dc96b4164742709711ceec148c5",
    sizeBytes: 34_737_671,
    executable: "officecli",
  },
  "linux-x64": {
    asset: "officecli-linux-x64",
    sha256: "449f0e6a1298e3c6d7da792d26ab53d04ba77bd990f299b51123c7aef383d2ce",
    sizeBytes: 35_319_717,
    executable: "officecli",
  },
  "win32-arm64": {
    asset: "officecli-win-arm64.exe",
    sha256: "9ab800745ef06f4d30b8fd41729c516a4b28c86a24a32af8764d12a6a5226d57",
    sizeBytes: 33_824_692,
    executable: "officecli.exe",
  },
  "win32-x64": {
    asset: "officecli-win-x64.exe",
    sha256: "760696b262f3d6bd2cd174577220d54541b6e1e04ec58dee051f1897395638b8",
    sizeBytes: 33_386_408,
    executable: "officecli.exe",
  },
};

const targetIds = parseTargets();
for (const targetId of targetIds) {
  const target = TARGETS[targetId];
  if (!target) fail(`unsupported officecli target: ${targetId}`);
  await buildTarget(targetId, target);
}

async function buildTarget(targetId, target) {
  const outDir = join(OUT_ROOT, targetId);
  const outPath = join(outDir, target.executable);
  if (matchesPinnedAsset(outPath, target)) {
    console.error(`[officecli-resources] using ${outPath}`);
    return;
  }
  const bytes = await downloadReleaseAsset(target.asset);
  if (bytes.length !== target.sizeBytes) {
    fail(`size mismatch for ${target.asset}: expected ${target.sizeBytes}, got ${bytes.length}`);
  }
  const actualHash = createHash("sha256").update(bytes).digest("hex");
  if (actualHash !== target.sha256) {
    fail(`checksum mismatch for ${target.asset}: expected ${target.sha256}, got ${actualHash}`);
  }
  const stagingPath = join(OUT_ROOT, `${target.executable}.download-${process.pid}-${Date.now()}`);
  mkdirSync(outDir, { recursive: true });
  try {
    writeStagingFile(stagingPath, bytes);
    if (targetId.startsWith("win32")) {
      renameSync(stagingPath, outPath);
    } else {
      // 可执行位在 rename 前设置：rename 保留 mode，避免先落盘出现无执行位窗口
      chmodSync(stagingPath, 0o755);
      renameSync(stagingPath, outPath);
    }
  } catch (error) {
    rmSync(stagingPath, { force: true });
    throw error;
  }
  console.error(`[officecli-resources] wrote ${outPath}`);
}

function matchesPinnedAsset(path, target) {
  try {
    if (!existsSync(path) || statSync(path).size !== target.sizeBytes) return false;
    const hash = createHash("sha256").update(readFileSync(path));
    return hash.digest("hex") === target.sha256;
  } catch {
    return false;
  }
}

function writeStagingFile(stagingPath, bytes) {
  writeFileSync(stagingPath, bytes, { mode: 0o600 });
}

async function downloadReleaseAsset(assetName) {
  const response = await fetchWithTrustedRedirects(`${RELEASE_ROOT}/${assetName}`);
  if (!response.ok) fail(`failed to download ${assetName}: HTTP ${response.status}`);
  if (!response.body) fail(`empty download body for ${assetName}`);
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_DOWNLOAD_BYTES) fail(`download exceeds size cap: ${assetName}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_DOWNLOAD_BYTES) fail(`download exceeds size cap: ${assetName}`);
  return bytes;
}

async function fetchWithTrustedRedirects(url) {
  let target = new URL(url);
  for (let redirectsLeft = 5; redirectsLeft >= 0; redirectsLeft--) {
    if (target.protocol !== "https:") fail(`insecure download protocol: ${target.protocol}`);
    if (!isTrustedDownloadHost(target.hostname)) fail(`untrusted download host: ${target.hostname}`);
    const response = await fetch(target, { redirect: "manual", headers: { "user-agent": "lume-desktop-build" } });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirectsLeft === 0) fail(`invalid or too many redirects for ${url}`);
      target = new URL(location, target);
      continue;
    }
    return response;
  }
  fail(`too many redirects for ${url}`);
}

function isTrustedDownloadHost(hostname) {
  return hostname === "github.com" || hostname.endsWith(".githubusercontent.com");
}

function parseTargets() {
  const explicit = [];
  for (let index = 2; index < process.argv.length; index++) {
    const arg = process.argv[index];
    if (arg === "--target" && process.argv[index + 1]) explicit.push(process.argv[++index]);
    else if (arg.startsWith("--target=")) explicit.push(arg.slice("--target=".length));
  }
  return explicit.length > 0 ? [...new Set(explicit)] : [currentTargetId()];
}

function currentTargetId() {
  return `${process.platform}-${process.arch}`;
}

function fail(message) {
  console.error(`[officecli-resources] ${message}`);
  process.exit(1);
}
