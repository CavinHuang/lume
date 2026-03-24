import { existsSync, realpathSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const dryRun = process.argv.includes("--dry-run");

function resolveInRepo(targetPath) {
  const resolved = realpathSync(targetPath);
  if (!resolved.toLowerCase().startsWith(repoRoot.toLowerCase())) {
    throw new Error(`拒绝删除仓库外路径: ${resolved}`);
  }
  return resolved;
}

function addIfExists(bucket, targetPath) {
  if (existsSync(targetPath)) {
    bucket.push(resolveInRepo(targetPath));
  }
}

function collectWorkspaceNodeModules(baseDir) {
  if (!existsSync(baseDir)) {
    return [];
  }

  return readdirSync(baseDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(baseDir, entry.name, "node_modules"))
    .filter((candidate) => existsSync(candidate));
}

function dedupeTargets(targets) {
  const sorted = [...new Set(targets)].sort();
  const unique = [];

  for (const candidate of sorted) {
    const nested = unique.some((existing) =>
      candidate.toLowerCase().startsWith(`${existing.toLowerCase()}${path.sep}`)
    );
    if (!nested) {
      unique.push(candidate);
    }
  }

  return unique;
}

const candidates = [];

addIfExists(candidates, path.join(repoRoot, "node_modules"));
addIfExists(candidates, path.join(repoRoot, "release"));
addIfExists(candidates, path.join(repoRoot, "out"));
addIfExists(candidates, path.join(repoRoot, "apps", "desktop", "src-tauri", "target"));
addIfExists(candidates, path.join(repoRoot, "apps", "sidecar", "dist"));
addIfExists(candidates, path.join(repoRoot, "apps", "web", "dist"));
addIfExists(candidates, path.join(repoRoot, "apps", "web", ".next"));
addIfExists(candidates, path.join(repoRoot, "apps", "web", "out"));

for (const baseDir of ["apps", "packages"]) {
  for (const nodeModulesPath of collectWorkspaceNodeModules(path.join(repoRoot, baseDir))) {
    addIfExists(candidates, nodeModulesPath);
  }
}

const targets = dedupeTargets(candidates);

if (targets.length === 0) {
  console.log("未发现需要清理的依赖或构建产物。");
  process.exit(0);
}

console.log("准备清理以下路径：");
for (const target of targets) {
  console.log(` - ${target}`);
}

if (dryRun) {
  console.log("DryRun 模式：未执行删除。");
  process.exit(0);
}

for (const target of targets) {
  rmSync(target, { recursive: true, force: true });
  console.log(`已删除: ${target}`);
}

console.log("清理完成。现在可以重新安装依赖或执行打包。");
