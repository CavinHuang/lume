import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SIDECAR_ENTRY = resolve(REPO_ROOT, "apps", "sidecar", "src", "index.ts");
const OUT_DIR = resolve(REPO_ROOT, "apps", "desktop", "resources", "sidecar");
const OUT_FILE = resolve(OUT_DIR, "index.mjs");

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

const args = [
  "build",
  SIDECAR_ENTRY,
  "--target=node",
  "--format=esm",
  `--outfile=${OUT_FILE}`,
];

console.error(`[sidecar-bundle] bun ${args.join(" ")}`);
const result = spawnSync("bun", args, { cwd: REPO_ROOT, stdio: "inherit" });
if (result.status !== 0) process.exit(result.status ?? 1);
if (!existsSync(OUT_FILE)) {
  console.error(`[sidecar-bundle] expected output not created: ${OUT_FILE}`);
  process.exit(1);
}
console.error(`[sidecar-bundle] wrote ${OUT_FILE}`);

// bun build 把 CommonJS require（JSON 数据文件 + 动态 JS）转成 createRequire(import.meta.url)
// 运行时 require，路径相对本 bundle 解析。standalone bundle 没有这些文件/包，运行时报
// MODULE_NOT_FOUND（css-tree 的 ../data/patch.json、../package.json；传递依赖 mdn-data/ajv 等
// 的包名 require）。补齐两类未 inline 资源。

const sidecarRequire = createRequire(resolve(REPO_ROOT, "apps", "sidecar", "package.json"));
let bundleSrc = readFileSync(OUT_FILE, "utf8");

// jsdom 用 CommonJS __dirname 读取默认样式表。bun 会把这个 __dirname 固化为构建机的
// 绝对路径，导致安装后启动即 ENOENT。样式表是静态数据，构建时直接嵌入产物。
const jsdomDirnamePattern = /^  var __dirname = ".*node_modules.*jsdom.*living.*css.*helpers";\r?\n/m;
const jsdomStyleReadPattern = /  var defaultStyleSheet = fs\.readFileSync\(path\d*\.resolve\(__dirname, "\.\.\/\.\.\/\.\.\/browser\/default-stylesheet\.css"\), \{ encoding: "utf-8" \}\);/;
if (!jsdomDirnamePattern.test(bundleSrc) || !jsdomStyleReadPattern.test(bundleSrc)) {
  console.error("[sidecar-bundle] jsdom stylesheet read pattern not found");
  process.exit(1);
}
const sdkRequire = createRequire(resolve(REPO_ROOT, "packages", "sdk", "package.json"));
const jsdomEntry = sdkRequire.resolve("jsdom");
const jsdomStylePath = resolve(dirname(jsdomEntry), "jsdom", "browser", "default-stylesheet.css");
const jsdomStyle = readFileSync(jsdomStylePath, "utf8");
bundleSrc = bundleSrc
  .replace(jsdomDirnamePattern, "")
  .replace(jsdomStyleReadPattern, `  var defaultStyleSheet = ${JSON.stringify(jsdomStyle)};`);
writeFileSync(OUT_FILE, bundleSrc);
console.error("[sidecar-bundle] embedded jsdom default stylesheet");

// (a) 相对路径 require（基准=本 bundle = resources/sidecar/）:
//     css-tree 的 ../data/patch.json -> resources/data/patch.json
//     css-tree 的 ../package.json    -> resources/package.json
try {
  const cssTreePkg = sidecarRequire.resolve("css-tree/package.json");
  const cssTreeRoot = dirname(cssTreePkg);
  const patchSrc = resolve(cssTreeRoot, "data", "patch.json");
  if (existsSync(patchSrc)) {
    const dataDir = resolve(dirname(OUT_DIR), "data");
    mkdirSync(dataDir, { recursive: true });
    copyFileSync(patchSrc, resolve(dataDir, "patch.json"));
    console.error(`[sidecar-bundle] copied css-tree data/patch.json -> resources/data/`);
  }
  copyFileSync(cssTreePkg, resolve(dirname(OUT_DIR), "package.json"));
  console.error(`[sidecar-bundle] copied css-tree package.json -> resources/package.json`);
} catch (e) {
  console.error(`[sidecar-bundle] warn: css-tree relative copies failed: ${e.message}`);
}

// (b) 包名 require: 扫描 bundle 的所有 createRequire require，把非内置的包（含传递依赖）
//     从 .bun cache 复制到 resources/sidecar/node_modules/<pkg>/。多版本传递依赖（如 ajv@6 vs
//     ajv@8）按 require 子路径选出 bundle 实际使用的版本。
const NODE_BUILTINS = new Set([
  "fs", "path", "os", "util", "events", "child_process", "stream", "http", "https",
  "net", "tls", "crypto", "zlib", "url", "querystring", "module", "process", "buffer",
  "timers", "async_hooks", "worker_threads", "perf_hooks", "assert", "vm", "string_decoder",
  "dns", "dgram", "cluster", "readline", "repl", "tty", "inspector", "diagnostics_channel",
  "console", "v8", "sys", "node:test",
]);
const reqsByPkg = new Map();
for (const m of bundleSrc.matchAll(/require[0-9]?\("([^"]+)"\)/g)) {
  const req = m[1];
  if (req.startsWith(".") || req.startsWith("node:") || NODE_BUILTINS.has(req)) continue;
  const pkg = req.startsWith("@") ? req.split("/").slice(0, 2).join("/") : req.split("/")[0];
  if (!reqsByPkg.has(pkg)) reqsByPkg.set(pkg, new Set());
  reqsByPkg.get(pkg).add(req);
}
const bunCacheDir = resolve(REPO_ROOT, "node_modules", ".bun");
const bunEntries = existsSync(bunCacheDir) ? readdirSync(bunCacheDir) : [];
const fileExistsUnder = (root, sub) => {
  const base = sub.replace(/\.(js|mjs|cjs|json)$/, "");
  return [sub, base + ".js", base + ".mjs", base + ".cjs", base + ".json", base + "/index.js", base + "/index.json"]
    .some((c) => existsSync(resolve(root, c)));
};
for (const [pkg, reqs] of reqsByPkg) {
  const cachePrefix = (pkg.includes("/") ? pkg.replace("/", "+") : pkg) + "@";
  const entries = bunEntries.filter((e) => e.startsWith(cachePrefix));
  // 选包含所有 require 子路径的版本（处理多版本传递依赖）
  const chosen = entries.find((entry) => {
    const pkgRoot = resolve(bunCacheDir, entry, "node_modules", pkg);
    return [...reqs].every((req) => {
      const sub = req.slice(pkg.length + 1);
      return !sub || fileExistsUnder(pkgRoot, sub);
    });
  }) ?? entries[0];
  if (!chosen) { console.error(`[sidecar-bundle] warn: not in .bun cache: ${pkg}`); continue; }
  const pkgRoot = resolve(bunCacheDir, chosen, "node_modules", pkg);
  const dest = resolve(OUT_DIR, "node_modules", pkg);
  rmSync(dest, { recursive: true, force: true });
  cpSync(pkgRoot, dest, { recursive: true });
  console.error(`[sidecar-bundle] copied ${pkg} (${chosen}) -> resources/sidecar/node_modules/${pkg}`);
}
