// 把 OpenConnector server bundle 成 standalone 单文件,替代打包整个 node_modules。
//
// 基于 PoC 验证:OpenConnector 19 个运行时依赖全为纯 JS(无 runtime native),bun build 可 inline
// 成 ~13MB,运行时功能完整(health / catalog / migrations / auth / action execute 全工作)。
// 对照 build-openconnector-resources.mjs 产出的 187MB(node_modules 95MB + src 42MB + catalog 49MB),
// bundle 形态仅保留 ~63MB(bundle + catalog + migrations + dist)。
//
// 输入 sourceDir(build-openconnector-resources.mjs 下载 + npm ci + build:web 产出的完整 OpenConnector
// 项目;默认从 .openconnector-cache/runtime-<sha[:12]>/ 读取,可用 LUME_OPENCONNECTOR_SOURCE_DIR
// 或首个位置参数覆盖),输出 resources/openconnector/ 的 bundle 形态:
//   openconnector.mjs(bundle) + catalog + migrations + dist/web + LICENSE/NOTICE + lume-resource.json
//
// 三处 bundle 工程处理点(PoC 验证,全部对标 build-sidecar-bundle.mjs 的既有手法):
//   1. proxy-agent —— urllib 的 try/catch 可选依赖探测 → --external(运行时被 catch 吞,行为不变)
//   2. NODE_ENV=production —— 构建期 define,消除 pino-pretty transport 分支(其 worker 线程解析在
//      bundle 后断裂);顺带启用 minify 与 dev 分支消除
//   3. migrations 路径 —— sqlite-runtime-store.ts 用 new URL("../../../migrations/", import.meta.url)
//      基于"源文件位置"推导,bundle 后 import.meta.url 指向 bundle 位置导致路径错位 → patch 为 "./"

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(REPO_ROOT, "scripts", "openconnector-resource.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const resourceDir = join(REPO_ROOT, "apps", "desktop", "resources", "openconnector");
const cacheDir = resolve(
  process.env.LUME_OPENCONNECTOR_CACHE_DIR || join(REPO_ROOT, "apps", "desktop", "resources", ".openconnector-cache"),
);
const defaultSourceDir = join(cacheDir, `runtime-${manifest.archiveSha256.slice(0, 12)}`);

if (process.argv.includes("--verify")) {
  verifyResource();
  console.error(`[openconnector-bundle] verified ${resourceDir}`);
  process.exit(0);
}

const sourceDir = resolve(process.env.LUME_OPENCONNECTOR_SOURCE_DIR || process.argv[2] || defaultSourceDir);
const entry = join(sourceDir, "src", "server", "index.ts");
const bundleOut = join(resourceDir, "openconnector.mjs");

// 1. 校验 sourceDir 完整(缺则提示先跑 build-openconnector-resources.mjs)
for (const rel of ["src/server/index.ts", "node_modules", "catalog", "migrations", "dist/web"]) {
  if (!existsSync(join(sourceDir, rel))) {
    throw new Error(
      `OpenConnector source missing: ${join(sourceDir, rel)}. Run scripts/build-openconnector-resources.mjs first.`,
    );
  }
}
console.error(`[openconnector-bundle] sourceDir: ${sourceDir}`);

// 2. 清空 resourceDir(保留稳定目录句柄,Windows utilityProcess 可能短暂占用)
mkdirSync(resourceDir, { recursive: true });
for (const child of readdirSync(resourceDir)) {
  rmSync(join(resourceDir, child), { recursive: true, force: true });
}

// 3. bun build → standalone bundle(production + minify + 排除可选依赖)
const buildArgs = [
  "build",
  entry,
  "--target=node",
  "--format=esm",
  "--minify",
  "--external=proxy-agent",
  `--outfile=${bundleOut}`,
];
console.error(`[openconnector-bundle] bun ${buildArgs.join(" ")}`);
const buildResult = spawnSync("bun", buildArgs, {
  cwd: sourceDir,
  env: { ...process.env, NODE_ENV: "production" },
  stdio: "inherit",
});
if (buildResult.status !== 0) {
  throw new Error(`bun build failed with exit code ${buildResult.status ?? "?"}`);
}
if (!existsSync(bundleOut)) {
  throw new Error(`bun build produced no output: ${bundleOut}`);
}
console.error(`[openconnector-bundle] wrote ${bundleOut}`);

// 4. patch migrations 相对路径(对齐 bundle 实际位置:migrations/ 与 bundle 同级)
let bundleSrc = readFileSync(bundleOut, "utf8");
const migrationsUrlPattern = /new URL\("\.\.\/\.\.\/\.\.\/migrations\/",\s*import\.meta\.url\)/;
if (!migrationsUrlPattern.test(bundleSrc)) {
  throw new Error(
    "migrations URL pattern not found in bundle; OpenConnector may have changed its path derivation — review scripts/build-openconnector-bundle.mjs",
  );
}
bundleSrc = bundleSrc.replace(migrationsUrlPattern, 'new URL("./migrations/", import.meta.url)');

// 检查构建机绝对路径残留(对标 build-sidecar-bundle.mjs 的 escapedRepoRoot 检查)。
// import.meta.url 不固化(全 bundle 仅 migrations 1 处,已 patch),故 health/catalog/migrations/auth
// 在 PoC 中已验证完整。已知残留为 CommonJS __dirname 固化:pino/thread-stream(生产 NODE_ENV=production
// 下 transport 分支 off,不触发)、sdk-base(仅 ali-oss 类 provider 触发)。降级为 warn 而非 throw:
// 这些路径不被生产路径触发,逐个 patch 收益低且 minified 后模式脆弱;未来 OpenConnector 升级若引入
// 新的 __dirname 残留,此处告警 + execute 实测会捕获。参见 follow-up: sdk-base __dirname patch。
const escapedSourceDir = JSON.stringify(sourceDir).slice(1, -1).toLowerCase();
const escapedPattern = escapedSourceDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const leakMatches = bundleSrc.toLowerCase().match(new RegExp(escapedPattern, "g"));
if (leakMatches) {
  console.warn(
    `[openconnector-bundle] WARN: ${leakMatches.length} build-machine path reference(s) to ${sourceDir} ` +
      `(known no-op in production: pino/thread-stream/sdk-base __dirname). Review on OpenConnector upgrade.`,
  );
}
writeFileSync(bundleOut, bundleSrc);
console.error("[openconnector-bundle] patched migrations path (../../../ -> ./)");

// 5. 复制数据资源(catalog/migrations/dist + LICENSE/NOTICE)。LICENSE 在 tarball 内为 LICENSE.txt、
//    在 runtime cache 内已重命名为 LICENSE,两种形态都兼容。
for (const name of ["catalog", "migrations", "dist"]) {
  cpSync(join(sourceDir, name), join(resourceDir, name), { recursive: true });
}
const licenseSrc = ["LICENSE.txt", "LICENSE"].map((n) => join(sourceDir, n)).find(existsSync);
if (licenseSrc) cpSync(licenseSrc, join(resourceDir, "LICENSE"));
const noticeSrc = ["NOTICE.md", "NOTICE"].map((n) => join(sourceDir, n)).find(existsSync);
if (noticeSrc) cpSync(noticeSrc, join(resourceDir, "NOTICE"));
console.error("[openconnector-bundle] copied catalog/migrations/dist + LICENSE/NOTICE");

// 6. 写 lume-resource.json(supervisor readMetadata 按 version/commit/archiveSha256 三重校验)
writeFileSync(
  join(resourceDir, "lume-resource.json"),
  `${JSON.stringify(
    {
      version: manifest.version,
      tag: manifest.tag,
      commit: manifest.commit,
      archiveSha256: manifest.archiveSha256,
      bundled: true,
    },
    null,
    2,
  )}\n`,
);

verifyResource();
console.error(`[openconnector-bundle] done -> ${resourceDir}`);

function verifyResource(root = resourceDir) {
  for (const rel of [
    "openconnector.mjs",
    "catalog/apps",
    "dist/web",
    "migrations",
    "LICENSE",
    "NOTICE",
    "lume-resource.json",
  ]) {
    if (!existsSync(join(root, rel))) {
      throw new Error(`OpenConnector bundle resource missing: ${rel}`);
    }
  }
  const metadata = JSON.parse(readFileSync(join(root, "lume-resource.json"), "utf8"));
  for (const key of ["version", "tag", "commit", "archiveSha256"]) {
    if (metadata[key] !== manifest[key]) {
      throw new Error(`OpenConnector resource metadata mismatch: ${key}`);
    }
  }
}
