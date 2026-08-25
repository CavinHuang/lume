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
const LOCAL_ONNX_WORKER_OUT_FILE = resolve(OUT_DIR, "local-embedding-worker.mjs");
const LOCAL_ONNX_RUNTIME_OUT_DIR = resolve(dirname(OUT_DIR), "bin", "napi-v3");
const sdkRequire = createRequire(resolve(REPO_ROOT, "packages", "sdk", "package.json"));
const jsdomEntry = sdkRequire.resolve("jsdom");
const jsdomLibDir = dirname(jsdomEntry);
const XHR_WORKER_ENTRY = resolve(jsdomLibDir, "jsdom", "living", "xhr", "xhr-sync-worker.js");
const LOCAL_ONNX_WORKER_ENTRY = resolve(
  REPO_ROOT,
  "apps",
  "sidecar",
  "src",
  "services",
  "memory-v2",
  "local-embedding-worker.ts",
);
const mxcPackageJson = sdkRequire.resolve("@microsoft/mxc-sdk/package.json");
const mxcRequire = createRequire(mxcPackageJson);
const nodePtyPackageJson = mxcRequire.resolve("node-pty/package.json");
const nodePtyRequire = createRequire(nodePtyPackageJson);
const RUNTIME_EXTERNAL_PACKAGES = [
  "@microsoft/mxc-sdk",
  "node-pty",
  "node-addon-api",
  "semver",
];
const RUNTIME_EXTERNAL_ROOTS = new Map([
  ["@microsoft/mxc-sdk", dirname(mxcPackageJson)],
  ["node-pty", dirname(nodePtyPackageJson)],
  ["node-addon-api", dirname(nodePtyRequire.resolve("node-addon-api/package.json"))],
  ["semver", dirname(mxcRequire.resolve("semver/package.json"))],
]);

mkdirSync(OUT_DIR, { recursive: true });
// Windows utilityProcess may keep the directory handle open briefly even after
// files are released. Clear children without deleting the stable directory.
for (const child of readdirSync(OUT_DIR)) {
  rmSync(resolve(OUT_DIR, child), { recursive: true, force: true });
}

for (const [entry, outfile] of [
  [SIDECAR_ENTRY, OUT_FILE],
  [XHR_WORKER_ENTRY, XHR_WORKER_OUT_FILE],
  [LOCAL_ONNX_WORKER_ENTRY, LOCAL_ONNX_WORKER_OUT_FILE],
]) {
  const args = [
    "build",
    entry,
    "--target=node",
    "--format=esm",
    ...RUNTIME_EXTERNAL_PACKAGES.map((pkg) => `--external=${pkg}`),
    `--outfile=${outfile}`,
  ];
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
let localOnnxWorkerSrc = readFileSync(LOCAL_ONNX_WORKER_OUT_FILE, "utf8");

// bun 会把 CommonJS __dirname/__filename 和 require.resolve 固化为构建机绝对路径。
// 内嵌 jsdom 静态样式表、随包提供同步 XHR worker，并删除仅用于错误栈的 undici 文件名。
const jsdomDirnamePattern = /^  var __dirname = ".*node_modules.*jsdom.*living.*css.*helpers";\r?\n/m;
const jsdomStyleReadPattern = /  var defaultStyleSheet = [A-Za-z_$][\w$]*\.readFileSync\([A-Za-z_$][\w$]*\.resolve\(__dirname, "\.\.\/\.\.\/\.\.\/browser\/default-stylesheet\.css"\), \{ encoding: "utf-8" \}\);/;
const undiciFilenamePattern = /^  var __filename = ".*node_modules.*undici.*index\.js";\r?\n/m;
const xhrWorkerResolvePattern = /  var syncWorkerFile = __require\.resolve\("[^"\r\n]*xhr-sync-worker\.js"\);/;
const sqlJsDirnamePattern = /^  var __dirname = ".*node_modules.*sql\.js.*dist", __filename = ".*node_modules.*sql\.js.*dist.*sql-wasm\.js";\r?\n/m;
// @larksuiteoapi/node-sdk 的 getSdkVersion() 用 __dirname 读自身 package.json 取版本号拼 User-Agent。
// bundle 里其 package.json 不会随包发布，路径必解析失败 → 已有 try/catch 兜底返回 'unknown'。
// 把绝对路径替换成 "."，避免可重定位性自检报错；版本号降级为 'unknown' 无功能影响。
const larkSdkDirnamePattern = /^  var __dirname = ".*node_modules.*larksuiteoapi.*node-sdk.*lib";\r?\n/m;
// thread-stream(pino 传递依赖)以绝对路径定位自身 worker.js;sidecar 不使用 pino transport,
// 与 Lark SDK 同款降级:__dirname 置 "." 保证 bundle 可重定位。
const threadStreamDirnamePattern = /^  var __dirname = ".*node_modules.*thread-stream";\r?\n/m;
const transformersDirnamePattern = /, __dirname = "[^"]*node_modules[^\"]*transformers[^\"]*dist", __webpack_modules__/;
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
if (!sqlJsDirnamePattern.test(bundleSrc)) {
  console.error("[sidecar-bundle] main: sql.js __dirname pattern not found");
  process.exit(1);
}
bundleSrc = bundleSrc.replace(
  sqlJsDirnamePattern,
  '  var __dirname = ".", __filename = "sql-wasm.js";',
);
if (!larkSdkDirnamePattern.test(bundleSrc)) {
  console.error("[sidecar-bundle] main: Lark SDK __dirname pattern not found");
  process.exit(1);
}
bundleSrc = bundleSrc.replace(
  larkSdkDirnamePattern,
  '  var __dirname = ".";',
);
if (!threadStreamDirnamePattern.test(bundleSrc)) {
  console.error("[sidecar-bundle] main: thread-stream __dirname pattern not found");
  process.exit(1);
}
bundleSrc = bundleSrc.replace(
  threadStreamDirnamePattern,
  '  var __dirname = ".";',
);
if (!transformersDirnamePattern.test(localOnnxWorkerSrc)) {
  console.error("[sidecar-bundle] local ONNX worker: transformers __dirname pattern not found");
  process.exit(1);
}
localOnnxWorkerSrc = localOnnxWorkerSrc.replace(
  transformersDirnamePattern,
  ', __dirname = ".", __webpack_modules__',
);
// 兜底:其余来自 node_modules 的单行 __dirname(pino 等传递依赖)统一降级为 ".",
// 避免每新增一个带固化路径的依赖就要补一个专用 pattern;未执行到的分支无行为差异。
const genericNodeModulesDirnamePattern = /^  var __dirname = "[^"]*node_modules[^"]*";\r?\n/gm;
bundleSrc = bundleSrc.replace(genericNodeModulesDirnamePattern, '  var __dirname = ".";\n');
writeFileSync(OUT_FILE, bundleSrc);
writeFileSync(XHR_WORKER_OUT_FILE, xhrWorkerSrc);
writeFileSync(LOCAL_ONNX_WORKER_OUT_FILE, localOnnxWorkerSrc);

const escapedRepoRoot = JSON.stringify(REPO_ROOT).slice(1, -1).toLowerCase();
for (const [label, source] of [["main", bundleSrc], ["xhr worker", xhrWorkerSrc], ["local ONNX worker", localOnnxWorkerSrc]]) {
  if (source.toLowerCase().includes(escapedRepoRoot)) {
    console.error(`[sidecar-bundle] ${label} still contains the build workspace path`);
    process.exit(1);
  }
}
console.error("[sidecar-bundle] embedded jsdom stylesheet and packaged relocatable workers");

const onnxRuntimeEntry = readdirSync(resolve(REPO_ROOT, "node_modules", ".bun"))
  .find((entry) => entry.startsWith("onnxruntime-node@1.21.0"));
if (!onnxRuntimeEntry) {
  console.error("[sidecar-bundle] missing onnxruntime-node@1.21.0 in Bun cache");
  process.exit(1);
}
const onnxRuntimeBinSource = resolve(
  REPO_ROOT,
  "node_modules",
  ".bun",
  onnxRuntimeEntry,
  "node_modules",
  "onnxruntime-node",
  "bin",
  "napi-v3",
  process.platform,
);
const onnxRuntimeBinTarget = process.platform === "darwin"
  ? resolve(LOCAL_ONNX_RUNTIME_OUT_DIR, process.platform)
  : resolve(LOCAL_ONNX_RUNTIME_OUT_DIR, process.platform, process.arch);
const onnxRuntimeArchSource = process.platform === "darwin"
  ? onnxRuntimeBinSource
  : resolve(onnxRuntimeBinSource, process.arch);
if (!existsSync(onnxRuntimeArchSource)) {
  console.error(`[sidecar-bundle] missing ONNX Runtime native files: ${onnxRuntimeArchSource}`);
  process.exit(1);
}
rmSync(onnxRuntimeBinTarget, { recursive: true, force: true });
mkdirSync(dirname(onnxRuntimeBinTarget), { recursive: true });
cpSync(onnxRuntimeArchSource, onnxRuntimeBinTarget, { recursive: true });
console.error(`[sidecar-bundle] copied ONNX Runtime native files -> resources/bin/napi-v3/${process.platform}`);

const sharpPlatform = `${process.platform}-${process.arch}`;
const sharpEntry = readdirSync(resolve(REPO_ROOT, "node_modules", ".bun"))
  .find((entry) => entry.startsWith(`@img+sharp-${sharpPlatform}@0.34.5`));
if (!sharpEntry) {
  console.error(`[sidecar-bundle] missing sharp native package for ${sharpPlatform}`);
  process.exit(1);
}
const sharpPackageName = `sharp-${sharpPlatform}`;
const sharpSource = resolve(
  REPO_ROOT,
  "node_modules",
  ".bun",
  sharpEntry,
  "node_modules",
  "@img",
  sharpPackageName,
);
const sharpTarget = resolve(OUT_DIR, "node_modules", "@img", sharpPackageName);
rmSync(sharpTarget, { recursive: true, force: true });
mkdirSync(dirname(sharpTarget), { recursive: true });
cpSync(sharpSource, sharpTarget, { recursive: true });
console.error(`[sidecar-bundle] copied sharp native package -> resources/sidecar/node_modules/@img/${sharpPackageName}`);

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
const runtimeBundleSrc = `${bundleSrc}\n${xhrWorkerSrc}\n${localOnnxWorkerSrc}`;
for (const m of runtimeBundleSrc.matchAll(/require[0-9]?\("([^"]+)"\)/g)) {
  const req = m[1];
  if (req.startsWith(".") || req.startsWith("node:") || NODE_BUILTINS.has(req)) continue;
  const pkg = req.startsWith("@") ? req.split("/").slice(0, 2).join("/") : req.split("/")[0];
  if (!reqsByPkg.has(pkg)) reqsByPkg.set(pkg, new Set());
  reqsByPkg.get(pkg).add(req);
}
for (const pkg of RUNTIME_EXTERNAL_PACKAGES) {
  if (!reqsByPkg.has(pkg)) reqsByPkg.set(pkg, new Set());
}
const bunCacheDir = resolve(REPO_ROOT, "node_modules", ".bun");
const bunEntries = existsSync(bunCacheDir) ? readdirSync(bunCacheDir) : [];
const fileExistsUnder = (root, sub) => {
  const base = sub.replace(/\.(js|mjs|cjs|json)$/, "");
  return [sub, base + ".js", base + ".mjs", base + ".cjs", base + ".json", base + "/index.js", base + "/index.json"]
    .some((c) => existsSync(resolve(root, c)));
};
for (const [pkg, reqs] of reqsByPkg) {
  const externalRoot = RUNTIME_EXTERNAL_ROOTS.get(pkg);
  const cachePrefix = (pkg.includes("/") ? pkg.replace("/", "+") : pkg) + "@";
  const entries = bunEntries.filter((e) => e.startsWith(cachePrefix));
  // 选包含所有 require 子路径的版本（处理多版本传递依赖）
  const chosen = externalRoot ? undefined : entries.find((entry) => {
    const pkgRoot = resolve(bunCacheDir, entry, "node_modules", pkg);
    return [...reqs].every((req) => {
      const sub = req.slice(pkg.length + 1);
      return !sub || fileExistsUnder(pkgRoot, sub);
    });
  }) ?? (externalRoot ? undefined : entries[0]);
  if (!externalRoot && !chosen) { console.error(`[sidecar-bundle] warn: not in .bun cache: ${pkg}`); continue; }
  const pkgRoot = externalRoot ?? resolve(bunCacheDir, chosen, "node_modules", pkg);
  const dest = resolve(OUT_DIR, "node_modules", pkg);
  rmSync(dest, { recursive: true, force: true });
  cpSync(pkgRoot, dest, { recursive: true });
  console.error(`[sidecar-bundle] copied ${pkg} (${externalRoot ? "resolved runtime dependency" : chosen}) -> resources/sidecar/node_modules/${pkg}`);
}

// (c) connectors 的 Apache-2.0 归属文件随分发包走:迁移代码编译进 index.mjs 构成再分发,
//     §4(a)/(d) 要求许可文本副本与 NOTICE 随衍生作品分发——只留在源码仓不满足安装包场景
for (const legal of ["LICENSE-Apache-2.0.txt", "NOTICE.md"]) {
  const src = resolve(REPO_ROOT, "apps", "sidecar", "src", "services", "connectors", legal);
  if (!existsSync(src)) { console.error(`[sidecar-bundle] warn: missing ${legal}`); continue; }
  copyFileSync(src, resolve(OUT_DIR, legal));
  console.error(`[sidecar-bundle] copied connectors/${legal} -> resources/sidecar/${legal}`);
}
