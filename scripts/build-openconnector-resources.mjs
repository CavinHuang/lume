import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { assertArchiveChecksum } from "./openconnector-resource-integrity.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(repoRoot, "scripts", "openconnector-resource.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const resourceDir = join(repoRoot, "apps", "desktop", "resources", "openconnector");
const cacheDir = resolve(process.env.LUME_OPENCONNECTOR_CACHE_DIR || join(repoRoot, "apps", "desktop", "resources", ".openconnector-cache"));
const archivePath = join(cacheDir, `open-connector-${manifest.version}.tar.gz`);
const builtCacheDir = join(cacheDir, `runtime-${manifest.archiveSha256.slice(0, 12)}`);

if (process.argv.includes("--verify")) {
  verifyResource();
  process.exit(0);
}

mkdirSync(cacheDir, { recursive: true });
if (!existsSync(archivePath)) await downloadArchive();
verifyArchive(archivePath);
if (isValidResource(builtCacheDir)) {
  installResource(builtCacheDir);
  verifyResource();
  process.exit(0);
}

const workDir = join(cacheDir, `work-${manifest.archiveSha256.slice(0, 12)}`);
const sourceDir = join(workDir, `open-connector-${manifest.version}`);
if (!existsSync(join(sourceDir, "package-lock.json"))) {
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });
  run("tar", ["-xzf", archivePath, "-C", workDir], repoRoot);
}

const npm = npmInvocation();
run(npm.command, [...npm.prefixArgs, "ci"], sourceDir);
run(npm.command, [...npm.prefixArgs, "run", "build:web"], sourceDir);
run(npm.command, [...npm.prefixArgs, "prune", "--omit=dev", "--workspaces=false"], sourceDir);

rmSync(resourceDir, { recursive: true, force: true });
mkdirSync(resourceDir, { recursive: true });
for (const name of ["src", "catalog", "dist", "migrations", "node_modules", "package.json", "package-lock.json"]) {
  cpSync(join(sourceDir, name), join(resourceDir, name), { recursive: true });
}
cpSync(join(sourceDir, "LICENSE.txt"), join(resourceDir, "LICENSE"));
cpSync(join(sourceDir, "NOTICE.md"), join(resourceDir, "NOTICE"));
removeDevelopmentFiles(resourceDir);
writeFileSync(join(resourceDir, "lume-resource.json"), `${JSON.stringify({
  version: manifest.version,
  tag: manifest.tag,
  commit: manifest.commit,
  archiveSha256: manifest.archiveSha256,
}, null, 2)}\n`);
verifyResource();
const temporaryBuiltCacheDir = `${builtCacheDir}.${process.pid}.tmp`;
rmSync(temporaryBuiltCacheDir, { recursive: true, force: true });
cpSync(resourceDir, temporaryBuiltCacheDir, { recursive: true });
rmSync(builtCacheDir, { recursive: true, force: true });
renameSync(temporaryBuiltCacheDir, builtCacheDir);

async function downloadArchive() {
  const response = await fetch(manifest.archiveUrl, { redirect: "follow" });
  if (!response.ok) throw new Error(`OpenConnector download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const temporary = `${archivePath}.${process.pid}.tmp`;
  writeFileSync(temporary, bytes);
  try { verifyArchive(temporary); } catch (error) { rmSync(temporary, { force: true }); throw error; }
  renameSync(temporary, archivePath);
}

function verifyArchive(path) {
  assertArchiveChecksum(path, manifest.archiveSha256);
}

function verifyResource(root = resourceDir) {
  for (const path of ["src/server/index.ts", "catalog/apps", "dist/web", "migrations", "node_modules", "LICENSE", "NOTICE", "package-lock.json", "lume-resource.json"]) {
    if (!existsSync(join(root, path))) throw new Error(`OpenConnector package input missing: ${path}`);
  }
  const metadata = JSON.parse(readFileSync(join(root, "lume-resource.json"), "utf8"));
  for (const key of ["version", "tag", "commit", "archiveSha256"]) {
    if (metadata[key] !== manifest[key]) throw new Error(`OpenConnector resource metadata mismatch: ${key}`);
  }
}

function isValidResource(root) {
  try { verifyResource(root); return true; } catch { return false; }
}

function installResource(root) {
  rmSync(resourceDir, { recursive: true, force: true });
  cpSync(root, resourceDir, { recursive: true });
}

function removeDevelopmentFiles(root) {
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) { stack.push(fullPath); continue; }
      if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name) || entry.name.endsWith(".map")) rmSync(fullPath, { force: true });
    }
  }
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
}
function npmInvocation() {
  const bundledCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  return existsSync(bundledCli) ? { command: process.execPath, prefixArgs: [bundledCli] } : { command: "npm", prefixArgs: [] };
}
