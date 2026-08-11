// 下载并构建 OpenConnector 源码到 sourceDir,供 scripts/build-openconnector-bundle.mjs 打成 standalone bundle。
//
// 职责仅限"源码获取":下载 GitHub tarball → sha256 校验 → npm ci → build:web(前端 dist)→ npm prune
// → 缓存到 .openconnector-cache/runtime-<sha[:12]>/。不再直接产出 resources/openconnector(由 bundle 脚本
// 接管),避免先把 187MB node_modules 复制进 resources 再被 bundle 覆盖的浪费。
//
// sourceDir 含:src(原始源码,bun build 入口)+ catalog + dist/web(build:web 产物)+ migrations
//   + node_modules(npm prune --omit=dev 后的 runtime deps,bun build 由此 inline 全部依赖)。
// 对比改造前:不再 removeDevelopmentFiles / 不再写 resources 的 lume-resource.json / 不再复制 src 到 app。

import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { assertArchiveChecksum } from "./openconnector-resource-integrity.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(repoRoot, "scripts", "openconnector-resource.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const cacheDir = resolve(
  process.env.LUME_OPENCONNECTOR_CACHE_DIR || join(repoRoot, "apps", "desktop", "resources", ".openconnector-cache"),
);
const archivePath = join(cacheDir, `open-connector-${manifest.version}.tar.gz`);
// sourceDir:构建好的 OpenConnector 项目根,bundle 脚本从此读取。
const sourceDir = join(cacheDir, `runtime-${manifest.archiveSha256.slice(0, 12)}`);

if (process.argv.includes("--verify")) {
  verifySourceDir(sourceDir);
  console.log(`[openconnector-resources] sourceDir verified: ${sourceDir}`);
  process.exit(0);
}

mkdirSync(cacheDir, { recursive: true });
if (!existsSync(archivePath)) await downloadArchive();
verifyArchive(archivePath);
if (isValidSourceDir(sourceDir)) {
  console.log(`[openconnector-resources] sourceDir ready (cached): ${sourceDir}`);
  process.exit(0);
}

// 解压 → npm ci → build:web → prune,产出完整 sourceDir。
const workDir = join(cacheDir, `work-${manifest.archiveSha256.slice(0, 12)}`);
const extractedRoot = join(workDir, `open-connector-${manifest.version}`);
if (!existsSync(join(extractedRoot, "package-lock.json"))) {
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });
  run("tar", ["-xzf", archivePath, "-C", workDir], repoRoot);
}

const npm = npmInvocation();
// open-connector 的 postinstall 直接执行 `node scripts/ensure-generated.ts`（.ts 文件）。
// Node 22 默认不支持直接执行 .ts（ERR_UNKNOWN_FILE_EXTENSION），需要 --experimental-strip-types。
// 只给 npm ci 注入 flag，避免影响 build:web / prune 的普通 .js 脚本。
const stripTypesOptions = [process.env.NODE_OPTIONS, "--experimental-strip-types"]
  .filter(Boolean)
  .join(" ");
run(npm.command, [...npm.prefixArgs, "ci"], extractedRoot, { env: { ...process.env, NODE_OPTIONS: stripTypesOptions } });
run(npm.command, [...npm.prefixArgs, "run", "build:web"], extractedRoot);
run(npm.command, [...npm.prefixArgs, "prune", "--omit=dev", "--workspaces=false"], extractedRoot);

// 原子缓存 sourceDir(供 build-openconnector-bundle.mjs 与后续增量 build 复用)。
const temporarySourceDir = `${sourceDir}.${process.pid}.tmp`;
rmSync(temporarySourceDir, { recursive: true, force: true });
cpSync(extractedRoot, temporarySourceDir, { recursive: true });
rmSync(sourceDir, { recursive: true, force: true });
renameSync(temporarySourceDir, sourceDir);

verifySourceDir(sourceDir);
console.log(`[openconnector-resources] sourceDir built -> ${sourceDir}`);
console.log("[openconnector-resources] next: scripts/build-openconnector-bundle.mjs");

async function downloadArchive() {
  const response = await fetch(manifest.archiveUrl, { redirect: "follow" });
  if (!response.ok) throw new Error(`OpenConnector download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const temporary = `${archivePath}.${process.pid}.tmp`;
  writeFileSync(temporary, bytes);
  try {
    verifyArchive(temporary);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  renameSync(temporary, archivePath);
}

function verifyArchive(path) {
  assertArchiveChecksum(path, manifest.archiveSha256);
}

function isValidSourceDir(root) {
  try {
    verifySourceDir(root);
    return true;
  } catch {
    return false;
  }
}

function verifySourceDir(root) {
  for (const p of ["src/server/index.ts", "node_modules", "catalog/apps", "migrations", "dist/web"]) {
    if (!existsSync(join(root, p))) {
      throw new Error(`OpenConnector sourceDir missing: ${p}`);
    }
  }
}

function run(command, args, cwd, options = {}) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", windowsHide: true, env: options.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
}

function npmInvocation() {
  const bundledCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  return existsSync(bundledCli) ? { command: process.execPath, prefixArgs: [bundledCli] } : { command: "npm", prefixArgs: [] };
}
