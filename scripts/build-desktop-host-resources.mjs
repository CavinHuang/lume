import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CRATE_DIR = resolve(REPO_ROOT, "crates", "lume-desktop-host");
const CRATE_MANIFEST = resolve(CRATE_DIR, "Cargo.toml");
const TARGET_ID = resolveTargetId(process.platform, process.arch);
const BINARY_NAME = process.platform === "win32" ? "lume_desktop_host.exe" : "lume_desktop_host";
const BUILT_BINARY = resolve(CRATE_DIR, "target", "release", BINARY_NAME);
const CURSOR_LICENSE = resolve(CRATE_DIR, "assets", "LICENSE.open-codex-computer-use");
const OUT_DIR = resolve(REPO_ROOT, "apps", "desktop", "resources", "desktop-host", TARGET_ID);
const MAC_BUNDLE_VARIANT = process.env.LUME_COMPUTER_USE_BUNDLE_VARIANT === "dev" ? "dev" : "release";
const MAC_BUNDLE_CONFIG = MAC_BUNDLE_VARIANT === "dev"
  ? {
      appBundleName: "Lume Computer Use (Dev).app",
      bundleIdentifier: "com.lume.computer-use.dev",
      displayName: "Lume Computer Use (Dev)",
    }
  : {
      appBundleName: "Lume Computer Use.app",
      bundleIdentifier: "com.lume.computer-use",
      displayName: "Lume Computer Use",
    };
const MAC_APP_BUNDLE_NAME = MAC_BUNDLE_CONFIG.appBundleName;
const MAC_BUNDLE_IDENTIFIER = MAC_BUNDLE_CONFIG.bundleIdentifier;
const MAC_BUNDLE_DISPLAY_NAME = MAC_BUNDLE_CONFIG.displayName;
const OUT_FILE = process.platform === "darwin"
  ? resolve(OUT_DIR, MAC_APP_BUNDLE_NAME, "Contents", "MacOS", BINARY_NAME)
  : resolve(OUT_DIR, BINARY_NAME);

const result = spawnSync("cargo", [
  "build",
  "--release",
  "--locked",
  "--manifest-path",
  CRATE_MANIFEST,
], { cwd: REPO_ROOT, stdio: "inherit" });
if (result.status !== 0) process.exit(result.status ?? 1);
if (!existsSync(BUILT_BINARY)) {
  console.error(`[desktop-host] expected output not created: ${BUILT_BINARY}`);
  process.exit(1);
}

rmSync(OUT_DIR, { recursive: true, force: true });
if (process.platform === "darwin") {
  writeMacAppBundle();
} else {
  mkdirSync(OUT_DIR, { recursive: true });
  copyFileSync(BUILT_BINARY, OUT_FILE);
  copyFileSync(CURSOR_LICENSE, resolve(OUT_DIR, "LICENSE.open-codex-computer-use"));
  console.error(`[desktop-host] wrote ${OUT_FILE}`);
}

function resolveTargetId(platform, arch) {
  if (platform === "win32" && arch === "x64") return "win32-x64-msvc";
  if (platform === "darwin" && arch === "x64") return "darwin-x64";
  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  throw new Error(`unsupported desktop host target: ${platform}-${arch}`);
}

function writeMacAppBundle() {
  const appRoot = resolve(OUT_DIR, MAC_APP_BUNDLE_NAME);
  const contentsDir = resolve(appRoot, "Contents");
  const macosDir = resolve(contentsDir, "MacOS");
  const resourcesDir = resolve(contentsDir, "Resources");
  mkdirSync(macosDir, { recursive: true });
  mkdirSync(resourcesDir, { recursive: true });
  copyFileSync(BUILT_BINARY, OUT_FILE);
  chmodSync(OUT_FILE, 0o755);
  copyFileSync(CURSOR_LICENSE, resolve(resourcesDir, "LICENSE.open-codex-computer-use"));
  writeFileSync(resolve(contentsDir, "Info.plist"), macInfoPlist());
  signMacAppBundle(appRoot);
  console.error(`[desktop-host] wrote ${appRoot}`);
}

function macInfoPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleExecutable</key>
  <string>${BINARY_NAME}</string>
  <key>CFBundleIdentifier</key>
  <string>${MAC_BUNDLE_IDENTIFIER}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>${MAC_BUNDLE_DISPLAY_NAME}</string>
  <key>CFBundleDisplayName</key>
  <string>${MAC_BUNDLE_DISPLAY_NAME}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>14.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>LumeComputerUseAppVariant</key>
  <string>${MAC_BUNDLE_VARIANT}</string>
</dict>
</plist>
`;
}

function signMacAppBundle(appRoot) {
  const mode = process.env.LUME_COMPUTER_USE_CODESIGN_MODE ?? "adhoc";
  if (mode === "none") {
    console.error(`[desktop-host] skipped codesign for ${appRoot}`);
    return;
  }
  const identity = process.env.LUME_COMPUTER_USE_CODESIGN_IDENTITY ?? "-";
  const result = spawnSync("codesign", ["--force", "--deep", "--sign", identity, appRoot], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
