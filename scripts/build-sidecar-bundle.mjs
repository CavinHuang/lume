import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SIDECAR_ENTRY = resolve(REPO_ROOT, "apps", "sidecar", "src", "index.ts");
const OUT_DIR = resolve(REPO_ROOT, "apps", "desktop", "resources", "sidecar");
const OUT_FILE = resolve(OUT_DIR, "index.mjs");
const XHR_WORKER_OUT_FILE = resolve(OUT_DIR, "xhr-sync-worker.mjs");
const sdkRequire = createRequire(resolve(REPO_ROOT, "packages", "sdk", "package.json"));
const jsdomEntry = sdkRequire.resolve("jsdom");
const jsdomLibDir = dirname(jsdomEntry);
const XHR_WORKER_ENTRY = resolve(jsdomLibDir, "jsdom", "living", "xhr", "xhr-sync-worker.js");

mkdirSync(OUT_DIR, { recursive: true });
// Windows utilityProcess may keep the directory handle open briefly even after
// files are released. Clear children without deleting the stable directory.
for (const child of readdirSync(OUT_DIR)) {
  rmSync(resolve(OUT_DIR, child), { recursive: true, force: true });
}

for (const [entry, outfile] of [
  [SIDECAR_ENTRY, OUT_FILE],
  [XHR_WORKER_ENTRY, XHR_WORKER_OUT_FILE],
]) {
  const args = ["build", entry, "--target=node", "--format=esm", `--outfile=${outfile}`];
  console.error(`[sidecar-bundle] bun ${args.join(" ")}`);
  const result = spawnSync("bun", args, { cwd: REPO_ROOT, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
  if (!existsSync(outfile)) {
    console.error(`[sidecar-bundle] expected output not created: ${outfile}`);
    process.exit(1);
  }
  console.error(`[sidecar-bundle] wrote ${outfile}`);
}

// bun build 把 CommonJS require（JSON 数据文件 + 动态 JS）转成 createRequire(import.meta.url)
// 运行时 require，路径相对本 bundle 解析。standalone bundle 没有这些文件/包，运行时报
// MODULE_NOT_FOUND（css-tree 的 ../data/patch.json、../package.json；传递依赖 mdn-data/ajv 等
// 的包名 require）。补齐两类未 inline 资源。

const sidecarRequire = createRequire(resolve(REPO_ROOT, "apps", "sidecar", "package.json"));
let bundleSrc = readFileSync(OUT_FILE, "utf8");
let xhrWorkerSrc = readFileSync(XHR_WORKER_OUT_FILE, "utf8");

// bun 会把 CommonJS __dirname/__filename 和 require.resolve 固化为构建机绝对路径。
// 内嵌 jsdom 静态样式表、随包提供同步 XHR worker，并删除仅用于错误栈的 undici 文件名。
const jsdomDirnamePattern = /^  var __dirname = ".*node_modules.*jsdom.*living.*css.*helpers";\r?\n/m;
const jsdomStyleReadPattern = /  var defaultStyleSheet = fs\.readFileSync\(path\d*\.resolve\(__dirname, "\.\.\/\.\.\/\.\.\/browser\/default-stylesheet\.css"\), \{ encoding: "utf-8" \}\);/;
const undiciFilenamePattern = /^  var __filename = ".*node_modules.*undici.*index\.js";\r?\n/m;
const xhrWorkerResolvePattern = /  var syncWorkerFile = __require\.resolve\("[^"\r\n]*xhr-sync-worker\.js"\);/;
const jsdomStylePath = resolve(jsdomLibDir, "jsdom", "browser", "default-stylesheet.css");
const jsdomStyle = readFileSync(jsdomStylePath, "utf8");
const makeRelocatable = (source, label) => {
  for (const [pattern, description] of [
    [jsdomDirnamePattern, "jsdom stylesheet __dirname"],
    [jsdomStyleReadPattern, "jsdom stylesheet read"],
    [undiciFilenamePattern, "undici __filename"],
    [xhrWorkerResolvePattern, "jsdom sync worker resolve"],
  ]) {
    if (!pattern.test(source)) {
      console.error(`[sidecar-bundle] ${label}: ${description} pattern not found`);
      process.exit(1);
    }
  }
  return source
    .replace(jsdomDirnamePattern, "")
    .replace(jsdomStyleReadPattern, `  var defaultStyleSheet = ${JSON.stringify(jsdomStyle)};`)
    .replace(undiciFilenamePattern, "")
    .replace(xhrWorkerResolvePattern, `  var syncWorkerFile = new URL("./xhr-sync-worker.mjs", import.meta.url);`);
};
bundleSrc = makeRelocatable(bundleSrc, "main");
xhrWorkerSrc = makeRelocatable(xhrWorkerSrc, "xhr worker");
writeFileSync(OUT_FILE, bundleSrc);
writeFileSync(XHR_WORKER_OUT_FILE, xhrWorkerSrc);

const escapedRepoRoot = JSON.stringify(REPO_ROOT).slice(1, -1).toLowerCase();
for (const [label, source] of [["main", bundleSrc], ["xhr worker", xhrWorkerSrc]]) {
  if (source.toLowerCase().includes(escapedRepoRoot)) {
    console.error(`[sidecar-bundle] ${label} still contains the build workspace path`);
    process.exit(1);
  }
}
console.error("[sidecar-bundle] embedded jsdom stylesheet and packaged relocatable sync worker");

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
const runtimeBundleSrc = `${bundleSrc}\n${xhrWorkerSrc}`;
for (const m of runtimeBundleSrc.matchAll(/require[0-9]?\("([^"]+)"\)/g)) {
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
