import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DESKTOP_DIR = resolve(REPO_ROOT, "apps", "desktop");
const sidecarBundle = resolve(DESKTOP_DIR, "resources", "sidecar", "index.mjs");
const xhrWorkerBundle = resolve(DESKTOP_DIR, "resources", "sidecar", "xhr-sync-worker.mjs");
const nativeBinary = resolve(DESKTOP_DIR, "resources", "natives", currentNativeTargetId(), "lume-natives.node");
const desktopMain = resolve(DESKTOP_DIR, "dist", "main", "main.mjs");
const desktopPreload = resolve(DESKTOP_DIR, "dist", "preload", "preload.cjs");
const requiredFiles = [
  desktopMain,
  desktopPreload,
  resolve(DESKTOP_DIR, "assets", "icon.png"),
  resolve(DESKTOP_DIR, "assets", "icon.ico"),
  resolve(DESKTOP_DIR, "assets", "icon.icns"),
  resolve(DESKTOP_DIR, "resources", "default-skills.tar"),
  sidecarBundle,
  xhrWorkerBundle,
  nativeBinary,
  resolve(REPO_ROOT, "apps", "web", "dist", "index.html"),
  resolve(REPO_ROOT, "apps", "web", "dist", "boot-theme.js"),
  resolve(REPO_ROOT, "apps", "web", "dist", "boot.css"),
];

for (const file of requiredFiles) {
  if (!existsSync(file)) fail(`missing package input: ${file}`);
}

const pkg = JSON.parse(readFileSync(resolve(DESKTOP_DIR, "package.json"), "utf8"));
const sidecarPkg = JSON.parse(readFileSync(resolve(REPO_ROOT, "apps", "sidecar", "package.json"), "utf8"));
if (pkg.main !== "dist/main/main.mjs") fail(`desktop main must be dist/main/main.mjs, got ${JSON.stringify(pkg.main)}`);
if (pkg.build?.artifactName !== "${productName}-${version}-${arch}.${ext}") {
  fail("desktop artifactName must include ${arch}");
}
if (pkg.devDependencies?.electron !== "42.5.1") {
  fail(`desktop electron version must be 42.5.1, got ${JSON.stringify(pkg.devDependencies?.electron)}`);
}
if (pkg.devDependencies?.["electron-log"] !== "5.4.4") {
  fail(`desktop must bundle electron-log 5.4.4 from devDependencies, got ${JSON.stringify(pkg.devDependencies?.["electron-log"])}`);
}
if (sidecarPkg.dependencies?.["electron-log"] !== "5.4.4") {
  fail(`sidecar runtime must depend on electron-log 5.4.4, got ${JSON.stringify(sidecarPkg.dependencies?.["electron-log"])}`);
}
if (pkg.devDependencies?.["electron-updater"] !== "6.8.9" || pkg.dependencies?.["electron-updater"]) {
  fail("electron-updater must be bundled from desktop devDependencies");
}

const resources = pkg.build?.extraResources ?? [];
for (const expected of ["../web/dist", "resources/default-skills.tar", "resources/sidecar", "resources/natives"]) {
  if (!resources.some((entry) => entry?.from === expected)) {
    fail(`electron-builder extraResources missing ${expected}`);
  }
}

const appFiles = pkg.build?.files ?? [];
const expectedAppFiles = ["dist/main/main.mjs", "dist/preload/preload.cjs", "assets"];
if (JSON.stringify(appFiles) !== JSON.stringify(expectedAppFiles)) {
  fail(`electron-builder files must be ${JSON.stringify(expectedAppFiles)}, got ${JSON.stringify(appFiles)}`);
}

verifyPngIsReadable(resolve(DESKTOP_DIR, "assets", "icon.png"));
verifyWebCsp(resolve(REPO_ROOT, "apps", "web", "dist", "index.html"));
verifyDesktopRuntime(desktopMain, desktopPreload, sidecarBundle);
console.error("[verify-package-inputs] ok");

function verifyPngIsReadable(file) {
  const bytes = readFileSync(file);
  const pngSignature = "89504e470d0a1a0a";
  if (bytes.subarray(0, 8).toString("hex") !== pngSignature) {
    fail(`app icon must be a PNG: ${file}`);
  }
}

function verifyWebCsp(file) {
  const html = readFileSync(file, "utf8");
  const csp = html.match(/<meta\s+http-equiv=["']Content-Security-Policy["']\s+content="([^"]+)"\s*\/?>/i)?.[1];
  if (!csp) fail(`web index missing Content-Security-Policy: ${file}`);
  for (const required of [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ]) {
    if (!csp.includes(required)) fail(`web CSP missing ${required}`);
  }
  if (/script-src[^;]*'unsafe-inline'/.test(csp)) {
    fail("web CSP must not allow inline scripts");
  }
  if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(html)) {
    fail("web index must not contain inline script tags");
  }
  for (const expected of ["/boot-theme.js", "/boot.css"]) {
    if (!html.includes(expected)) fail(`web index missing ${expected}`);
  }
}

function verifyDesktopRuntime(mainFile, preloadFile, bundleFile) {
  const mainSource = readFileSync(mainFile, "utf8");
  const preloadSource = readFileSync(preloadFile, "utf8");
  const bundleSource = readFileSync(bundleFile, "utf8");
  if (!mainSource.includes("utilityProcess.fork")) {
    fail("desktop main must start the sidecar with Electron utilityProcess");
  }
  if (!mainSource.includes("LUME_NATIVES_PATH")) {
    fail("desktop main must pass LUME_NATIVES_PATH to the sidecar only");
  }
  if (!mainSource.includes("system.ready")) {
    fail("desktop main must wait for sidecar system.ready");
  }
  if (!mainSource.includes("system.log") || !mainSource.includes("writeDesktopLogRecord")) {
    fail("desktop main must collect structured sidecar logs through system.log");
  }
  if (!mainSource.includes("electron-log") && !mainSource.includes("lume-desktop-ndjson")) {
    fail("desktop main must use electron-log for structured file logging");
  }
  if (!bundleSource.includes("process.parentPort")) {
    fail("sidecar bundle must support Electron utility parentPort transport");
  }
  if (!bundleSource.includes("system.log")) {
    fail("sidecar bundle must emit structured logs through Electron utility parentPort");
  }
  if (!bundleSource.includes("electron-log") && !bundleSource.includes("lume-sidecar-ndjson")) {
    fail("sidecar bundle must use electron-log for fallback file logging");
  }
  if (mainSource.includes("ELECTRON_RUN_AS_NODE")) {
    fail("desktop main must not depend on ELECTRON_RUN_AS_NODE");
  }
  const preloadRequires = [...preloadSource.matchAll(/require\((['"])(.*?)\1\)/g)]
    .map((match) => match[2]);
  if (JSON.stringify(preloadRequires) !== JSON.stringify(["electron"])) {
    fail(`desktop preload must require only electron, got ${JSON.stringify(preloadRequires)}`);
  }
}

function currentNativeTargetId() {
  if (process.platform === "darwin" && process.arch === "arm64") return "darwin-arm64";
  if (process.platform === "darwin" && process.arch === "x64") return "darwin-x64";
  if (process.platform === "win32" && process.arch === "x64") return "win32-x64-msvc";
  if (process.platform === "linux" && process.arch === "arm64") return "linux-arm64-gnu";
  if (process.platform === "linux" && process.arch === "x64") return "linux-x64-gnu";
  fail(`unsupported native target: ${process.platform}-${process.arch}`);
}

function fail(message) {
  console.error(`[verify-package-inputs] ${message}`);
  process.exit(1);
}
