import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_ROOT = resolve(REPO_ROOT, "apps", "desktop", "resources", "ripgrep");
const VERSION = "15.0.0";
const RELEASE_ROOT = `https://github.com/BurntSushi/ripgrep/releases/download/${VERSION}`;
const allowSystemFallback = process.argv.includes("--allow-system-fallback");

const TARGETS = {
  "win32-x64-msvc": {
    asset: `ripgrep-${VERSION}-x86_64-pc-windows-msvc.zip`,
    sha256: "21a98bf42c4da97ca543c010e764cc6dec8b9b7538d05f8d21874016385e0860",
    executable: "rg.exe",
  },
  "darwin-x64": {
    asset: `ripgrep-${VERSION}-x86_64-apple-darwin.tar.gz`,
    sha256: "44128c733d127ddbda461e01225a68b5f9997cfe7635242a797f645ca674a71a",
    executable: "rg",
  },
  "darwin-arm64": {
    asset: `ripgrep-${VERSION}-aarch64-apple-darwin.tar.gz`,
    sha256: "98bb2e61e7277ba0ea72d2ae2592497fd8d2940934a16b122448d302a6637e3b",
    executable: "rg",
  },
};

const targetIds = parseTargets();
for (const targetId of targetIds) {
  const target = TARGETS[targetId];
  if (!target) fail(`unsupported ripgrep target: ${targetId}`);
  await buildTarget(targetId, target);
}

async function buildTarget(targetId, target) {
  const outDir = join(OUT_ROOT, targetId);
  const versionFile = join(outDir, "VERSION");
  const fallbackFile = join(outDir, "SYSTEM-FALLBACK");
  const hasBundledLicense = existsSync(join(outDir, "LICENSE.ripgrep"));
  const hasDevelopmentFallback = allowSystemFallback && existsSync(fallbackFile);
  if (
    existsSync(join(outDir, target.executable)) &&
    existsSync(versionFile) &&
    readFileSync(versionFile, "utf8").trim() === VERSION &&
    (hasBundledLicense || hasDevelopmentFallback)
  ) {
    console.error(`[ripgrep-resources] using ${join(outDir, target.executable)}`);
    return;
  }
  const tempRoot = mkdtempSync(join(tmpdir(), "lume-ripgrep-"));
  try {
    const archivePath = join(tempRoot, target.asset);
    const extractRoot = join(tempRoot, "extract");
    let response;
    try {
      response = await fetch(`${RELEASE_ROOT}/${target.asset}`, {
        headers: { "user-agent": "lume-desktop-build", accept: "application/octet-stream" },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (allowSystemFallback && useSystemFallback(targetId, target, message)) return;
      fail(`failed to download ${target.asset}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) {
      if (allowSystemFallback && useSystemFallback(targetId, target, `HTTP ${response.status}`)) return;
      fail(`failed to download ${target.asset}: HTTP ${response.status}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const actualHash = createHash("sha256").update(bytes).digest("hex");
    if (actualHash !== target.sha256) {
      fail(`checksum mismatch for ${target.asset}: expected ${target.sha256}, got ${actualHash}`);
    }
    writeFileSync(archivePath, bytes);
    extractArchive(archivePath, extractRoot, target.asset.endsWith(".zip"));

    const executablePath = findFile(extractRoot, target.executable);
    const licensePath = findFile(extractRoot, "COPYING");
    if (!executablePath || !licensePath) fail(`archive ${target.asset} is missing rg or COPYING`);

    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    copyFileSync(executablePath, join(outDir, target.executable));
    copyFileSync(licensePath, join(outDir, "LICENSE.ripgrep"));
    writeFileSync(versionFile, `${VERSION}\n`);
    if (process.platform !== "win32") {
      const chmod = spawnSync("chmod", ["755", join(outDir, target.executable)], { stdio: "inherit" });
      if (chmod.status !== 0) fail(`failed to mark ${target.executable} executable`);
    }
    console.error(`[ripgrep-resources] wrote ${join(outDir, target.executable)}`);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function useSystemFallback(targetId, target, reason) {
  if (targetId !== currentTargetId()) return false;
  const lookup = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(lookup, [target.executable], { encoding: "utf8" });
  if (result.status !== 0) return false;
  const executablePath = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && existsSync(line));
  if (!executablePath) return false;

  const outDir = join(OUT_ROOT, targetId);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  copyFileSync(executablePath, join(outDir, target.executable));
  writeFileSync(join(outDir, "VERSION"), `${VERSION}\n`);
  writeFileSync(join(outDir, "SYSTEM-FALLBACK"), `${executablePath}\n`);
  console.error(
    `[ripgrep-resources] download unavailable (${reason}); using system ${executablePath} for development`,
  );
  return true;
}

function extractArchive(archivePath, extractRoot, isZip) {
  mkdirSync(extractRoot, { recursive: true });
  const args = isZip ? ["-xf", archivePath, "-C", extractRoot] : ["-xzf", archivePath, "-C", extractRoot];
  const tarResult = spawnSync("tar", args, { stdio: "inherit" });
  if (tarResult.status === 0) return;
  if (isZip && process.platform === "win32") {
    const shell = process.env.ComSpec?.replace(/cmd\.exe$/i, "powershell.exe") || "powershell.exe";
    const powershellResult = spawnSync(shell, [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force",
      archivePath,
      extractRoot,
    ], { stdio: "inherit" });
    if (powershellResult.status === 0) return;
  }
  fail(`failed to extract ${basename(archivePath)}`);
}

function findFile(root, name) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = findFile(full, name);
      if (nested) return nested;
    } else if (entry.isFile() && entry.name === name && statSync(full).size > 0) {
      return full;
    }
  }
  return undefined;
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
  if (process.platform === "win32" && process.arch === "x64") return "win32-x64-msvc";
  if (process.platform === "darwin" && process.arch === "x64") return "darwin-x64";
  if (process.platform === "darwin" && process.arch === "arm64") return "darwin-arm64";
  fail(`ripgrep resources are unsupported on ${process.platform}-${process.arch}`);
}

function fail(message) {
  console.error(`[ripgrep-resources] ${message}`);
  process.exit(1);
}
