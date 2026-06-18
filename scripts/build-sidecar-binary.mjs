import { copyFileSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, unlinkSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { deflateSync } from "node:zlib";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SIDECAR_ENTRY = resolve(REPO_ROOT, "apps", "sidecar", "src", "index.ts");
const SIDECAR_DIR = resolve(REPO_ROOT, "apps", "sidecar");
const OUTFILE = resolve(REPO_ROOT, "apps", "desktop", "src-tauri", "binaries", "lume-sidecar.js");
const NODE_MODULES_SRC = resolve(SIDECAR_DIR, "node_modules");
const NODE_MODULES_ZIP = resolve(REPO_ROOT, "apps", "desktop", "src-tauri", "binaries", "sidecar-node-modules.zip");
const BRIDGE_SRC = resolve(REPO_ROOT, "apps", "desktop", "scripts", "sidecar-node-bridge.mjs");
const BRIDGE_DST = resolve(REPO_ROOT, "apps", "desktop", "src-tauri", "binaries", "sidecar-node-bridge.mjs");

// css-tree runtime deps (installed at workspace root by Bun)
const WORKSPACE_NM = resolve(REPO_ROOT, "node_modules", ".bun", "node_modules");
const packagesToCopy = ["css-tree", "source-map-js", "mdn-data"];

const TARGETS = {
  "aarch64-apple-darwin": { bunTarget: "bun-darwin-arm64" },
  "x86_64-apple-darwin": { bunTarget: "bun-darwin-x64" },
  "x86_64-pc-windows-msvc": { bunTarget: "bun-windows-x64" },
  "x86_64-unknown-linux-gnu": { bunTarget: "bun-linux-x64" },
  "aarch64-unknown-linux-gnu": { bunTarget: "bun-linux-arm64" },
};

function parseTargetTriple() {
  const explicitIndex = process.argv.indexOf("--tauri-target");
  if (explicitIndex >= 0 && process.argv[explicitIndex + 1]) {
    return process.argv[explicitIndex + 1];
  }
  if (process.env.TAURI_TARGET_TRIPLE) return process.env.TAURI_TARGET_TRIPLE;
  if (process.platform === "darwin" && process.arch === "arm64") return "aarch64-apple-darwin";
  if (process.platform === "darwin") return "x86_64-apple-darwin";
  if (process.platform === "win32") return "x86_64-pc-windows-msvc";
  if (process.platform === "linux" && process.arch === "arm64") return "aarch64-unknown-linux-gnu";
  return "x86_64-unknown-linux-gnu";
}

const targetTriple = parseTargetTriple();
const target = TARGETS[targetTriple];
if (!target) {
  console.error(`[sidecar-binary] unsupported Tauri target: ${targetTriple}`);
  process.exit(1);
}

mkdirSync(dirname(OUTFILE), { recursive: true });

// Bundle as JS (not --compile) so require() resolves at runtime from the real filesystem.
// css-tree is kept external because its data/patch.json require fails in the compiled
// binary's virtual filesystem — it resolves from the bundled node_modules/ at runtime.
const args = [
  "build",
  SIDECAR_ENTRY,
  "--bundle",
  "--target=bun",
  "--external",
  "css-tree",
  `--outfile=${OUTFILE}`,
];

console.error(`[sidecar-binary] bun ${args.join(" ")}`);
const result = spawnSync("bun", args, {
  cwd: REPO_ROOT,
  stdio: "inherit",
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

if (!existsSync(OUTFILE)) {
  console.error(`[sidecar-binary] ERROR: expected output not created at ${OUTFILE}`);
  process.exit(1);
}

// Package sidecar node_modules (dereferencing symlinks) so the bundled app has
// real files for external requires (css-tree data/patch.json, source-map-js, mdn-data, etc.).
// Packages are installed at the workspace root by Bun's package manager.
const tmpDir = resolve(REPO_ROOT, "apps", "desktop", "src-tauri", "binaries", "_nm-tmp");
// Clean and recreate temp dir
rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(tmpDir, { recursive: true });

console.error(`[sidecar-binary] workspace nm: ${existsSync(WORKSPACE_NM) ? "found" : "NOT FOUND"} at ${WORKSPACE_NM}`);
console.error(`[sidecar-binary] sidecar nm: ${existsSync(NODE_MODULES_SRC) ? "found" : "NOT FOUND"} at ${NODE_MODULES_SRC}`);

let stagedCount = 0;
for (const pkg of packagesToCopy) {
  const src = resolve(WORKSPACE_NM, pkg);
  const fallback = resolve(NODE_MODULES_SRC, pkg);
  const wsExists = existsSync(src);
  const fbExists = existsSync(fallback);
  const pkgSrc = wsExists ? src : fbExists ? fallback : null;
  if (!pkgSrc) {
    console.error(`[sidecar-binary] WARNING: ${pkg} not found (workspace:${wsExists}, sidecar:${fbExists})`);
    continue;
  }
  const srcLabel = wsExists ? "workspace" : "sidecar";
  const dst = resolve(tmpDir, pkg);
  mkdirSync(dst, { recursive: true });
  copyDirReal(pkgSrc, dst);
  stagedCount += 1;
  console.error(`[sidecar-binary] staged ${pkg} from ${srcLabel}: ${pkgSrc}`);
}

if (stagedCount === 0) {
  console.error("[sidecar-binary] no node_modules packages were staged");
  process.exit(1);
}

// Zip the staged node_modules for Tauri bundling
console.error(`[sidecar-binary] creating zip: ${NODE_MODULES_ZIP}`);
if (existsSync(NODE_MODULES_ZIP)) {
  unlinkSync(NODE_MODULES_ZIP);
}
const zipResult = createZip(tmpDir, NODE_MODULES_ZIP);
if (zipResult.status !== 0) {
  console.error(`[sidecar-binary] zip failed, trying Node.js fallback`);
  const fb = createZipNode(tmpDir, NODE_MODULES_ZIP);
  if (fb.status !== 0) process.exit(1);
}
if (!existsSync(NODE_MODULES_ZIP)) {
  console.error(`[sidecar-binary] ERROR: zip not created at ${NODE_MODULES_ZIP}`);
  process.exit(1);
}
console.error(`[sidecar-binary] zip created (${statSync(NODE_MODULES_ZIP).size} bytes)`);
// Clean up temp dir
rmSync(tmpDir, { recursive: true, force: true });

// Copy node-bridge script into binaries/ so Tauri can bundle it as a resource
if (existsSync(BRIDGE_SRC)) {
    copyFileSync(BRIDGE_SRC, BRIDGE_DST);
    console.error(`[sidecar-binary] copied bridge -> ${BRIDGE_DST}`);
} else {
    console.error(`[sidecar-binary] WARNING: bridge script not found at ${BRIDGE_SRC}`);
}

console.error(`[sidecar-binary] wrote ${OUTFILE}`);

function copyDirReal(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src)) {
    const s = resolve(src, entry);
    const d = resolve(dst, entry);
    // realpathSync dereferences symlinks and junctions on all platforms
    const realSrc = realpathSync(s);
    const st = statSync(realSrc);
    if (st.isDirectory()) {
      copyDirReal(realSrc, d);
    } else {
      copyFileSync(realSrc, d);
    }
  }
}

function createZip(sourceDir, zipPath) {
  if (process.platform === "win32") {
    const r = spawnSync("powershell.exe", [
      "-NoProfile",
      "-Command",
      "Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory($args[0], $args[1])",
      sourceDir, zipPath,
    ], { stdio: "pipe" });
    if (r.status === 0) return r;
    return createZipNode(sourceDir, zipPath);
  }
  return spawnSync("zip", ["-r", "-q", zipPath, "."], { cwd: sourceDir, stdio: "inherit" });
}

function createZipNode(sourceDir, zipPath) {
  try {
    const entries = collectEntries(sourceDir);
    const parts = [];
    const cdParts = [];
    let offset = 0;
    for (const e of entries) {
      const data = readFileSync(e.full);
      const compressed = deflateSync(data);
      const local = buildLocalHeader(e.rel, compressed.length, e.size);
      parts.push(local, compressed);
      cdParts.push(buildCentralHeader(e.rel, compressed.length, e.size, offset));
      offset += local.length + compressed.length;
    }
    const cd = Buffer.concat(cdParts);
    const eocd = buildEOCD(entries.length, cd.length, offset);
    writeFileSync(zipPath, Buffer.concat([...parts, cd, eocd]));
    return { status: 0 };
  } catch (err) {
    console.error(`[sidecar-binary] Node.js zip failed: ${err.message}`);
    return { status: 1 };
  }
}

function collectEntries(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = resolve(dir, name);
    if (statSync(full).isDirectory()) out.push(...collectEntries(full));
    else out.push({ full, rel: full.slice(full.indexOf(dir) + dir.length + 1), size: statSync(full).size });
  }
  return out;
}

function buildLocalHeader(name, compSize, uncompSize) {
  const nb = Buffer.from(name, "utf-8");
  const h = Buffer.alloc(30 + nb.length);
  let p = 0;
  writeU32(h, p, 0x04034b50); p += 4;
  writeU16(h, p, 20); p += 2; writeU16(h, p, 0); p += 2; writeU16(h, p, 8); p += 2;
  writeU16(h, p, 0); p += 2; writeU32(h, p, 0); p += 4;
  writeU32(h, p, compSize); p += 4; writeU32(h, p, uncompSize); p += 4;
  writeU16(h, p, nb.length); p += 2; writeU16(h, p, 0); p += 2;
  nb.copy(h, p);
  return h;
}

function buildCentralHeader(name, compSize, uncompSize, offset) {
  const nb = Buffer.from(name, "utf-8");
  const h = Buffer.alloc(46 + nb.length);
  let p = 0;
  writeU32(h, p, 0x02014b50); p += 4; writeU16(h, p, 20); p += 2;
  writeU16(h, p, 20); p += 2; writeU16(h, p, 0); p += 2; writeU16(h, p, 8); p += 2;
  writeU16(h, p, 0); p += 4; writeU32(h, p, 0); p += 4;
  writeU32(h, p, compSize); p += 4; writeU32(h, p, uncompSize); p += 4;
  writeU16(h, p, nb.length); p += 2; writeU16(h, p, 0); p += 2;
  writeU16(h, p, 0); p += 2; writeU16(h, p, 0); p += 2;
  writeU16(h, p, 0); p += 2; writeU32(h, p, 0); p += 4; writeU32(h, p, offset); p += 4;
  nb.copy(h, p);
  return h;
}

function buildEOCD(count, cdSize, cdOffset) {
  const b = Buffer.alloc(22);
  let p = 0;
  writeU32(b, p, 0x06054b50); p += 4; writeU16(b, p, 0); p += 2;
  writeU16(b, p, 0); p += 2; writeU16(b, p, count); p += 2;
  writeU16(b, p, count); p += 2; writeU32(b, p, cdSize); p += 4;
  writeU32(b, p, cdOffset); p += 4; writeU16(b, p, 0);
  return b;
}
function writeU32(b, p, v) { b.writeUInt32LE(v, p); }
function writeU16(b, p, v) { b.writeUInt16LE(v, p); }
