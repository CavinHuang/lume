import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CRATE_DIR = resolve(REPO_ROOT, "crates", "lume-desktop-host");
const CRATE_MANIFEST = resolve(CRATE_DIR, "Cargo.toml");
const REQUESTED_TARGET = argumentValue("--target");
const TARGET = resolveBuildTarget(process.platform, process.arch, REQUESTED_TARGET);
const TARGET_ID = TARGET.id;
const BINARY_NAME = process.platform === "win32" ? "lume_desktop_host.exe" : "lume_desktop_host";
const BUILT_BINARY = TARGET.rustTarget
  ? resolve(CRATE_DIR, "target", TARGET.rustTarget, "release", BINARY_NAME)
  : resolve(CRATE_DIR, "target", "release", BINARY_NAME);
const CURSOR_LICENSE = resolve(CRATE_DIR, "assets", "LICENSE.open-codex-computer-use");
const MAC_CURSOR_OVERLAY_SOURCE = resolve(CRATE_DIR, "macos", "LumeComputerUseCursorOverlay.swift");
const MAC_CURSOR_OVERLAY_BINARY_NAME = "LumeComputerUseCursorOverlay";
const MAC_PERMISSION_GUIDE_SOURCE = resolve(CRATE_DIR, "macos", "LumeComputerUsePermissionGuide.swift");
const MAC_PERMISSION_GUIDE_BINARY_NAME = "LumeComputerUsePermissionGuide";
const MAC_SCREEN_CAPTURE_SOURCE = resolve(CRATE_DIR, "macos", "LumeComputerUseScreenCapture.swift");
const MAC_SCREEN_CAPTURE_BINARY_NAME = "LumeComputerUseScreenCapture";
const MAC_EVENT_MONITOR_SOURCE = resolve(CRATE_DIR, "macos", "LumeComputerUseEventMonitor.swift");
const MAC_EVENT_MONITOR_BINARY_NAME = "LumeComputerUseEventMonitor";
const MAC_APP_DISCOVERY_SOURCE = resolve(CRATE_DIR, "macos", "LumeComputerUseAppDiscovery.swift");
const MAC_APP_DISCOVERY_BINARY_NAME = "LumeComputerUseAppDiscovery";
const MAC_CURSOR_ASSET_NAME = "official-software-cursor-window-252.png";
const MAC_CURSOR_ASSET_SOURCE = resolve(CRATE_DIR, "assets", MAC_CURSOR_ASSET_NAME);
const MAC_BUNDLE_ICON_NAME = "LumeComputerUse.icns";
const MAC_BUNDLE_ICONSET_NAME = "LumeComputerUse.iconset";
const MAC_BUNDLE_ICON_ENTRIES = [
  ["icon_16x16.png", 16],
  ["icon_16x16@2x.png", 32],
  ["icon_32x32.png", 32],
  ["icon_32x32@2x.png", 64],
  ["icon_128x128.png", 128],
  ["icon_128x128@2x.png", 256],
  ["icon_256x256.png", 256],
  ["icon_256x256@2x.png", 512],
  ["icon_512x512.png", 512],
  ["icon_512x512@2x.png", 1024],
];
const OUT_DIR = resolve(REPO_ROOT, "apps", "desktop", "resources", "desktop-host", TARGET_ID);
const MAC_BUNDLE_VARIANT = process.env.LUME_COMPUTER_USE_BUNDLE_VARIANT === "dev" ? "dev" : "release";
const REQUIRE_STABLE_SIGNING = process.argv.includes("--require-stable-signing");
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

const cargoArgs = [
  "build",
  "--release",
  "--locked",
  "--manifest-path",
  CRATE_MANIFEST,
];
if (TARGET.rustTarget) cargoArgs.push("--target", TARGET.rustTarget);
const result = spawnSync("cargo", cargoArgs, { cwd: REPO_ROOT, stdio: "inherit" });
if (result.status !== 0) process.exit(result.status ?? 1);
if (!existsSync(BUILT_BINARY)) {
  console.error(`[desktop-host] expected output not created: ${BUILT_BINARY}`);
  process.exit(1);
}

if (process.platform === "darwin") {
  rmSync(OUT_DIR, { recursive: true, force: true });
  writeMacAppBundle();
} else {
  mkdirSync(OUT_DIR, { recursive: true });
  copyIfChanged(BUILT_BINARY, OUT_FILE);
  copyIfChanged(CURSOR_LICENSE, resolve(OUT_DIR, "LICENSE.open-codex-computer-use"));
  if (REQUIRE_STABLE_SIGNING) signWindowsBinary(OUT_FILE);
  console.error(`[desktop-host] wrote ${OUT_FILE}`);
}

function copyIfChanged(source, destination) {
  if (existsSync(destination) && readFileSync(source).equals(readFileSync(destination))) return;
  copyFileSync(source, destination);
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function resolveBuildTarget(platform, arch, requestedTarget) {
  if (platform === "win32" && arch === "x64" && !requestedTarget) return { id: "win32-x64-msvc" };
  if (platform === "darwin" && requestedTarget === "aarch64-apple-darwin") {
    return { id: "darwin-arm64", rustTarget: requestedTarget, swiftTarget: "arm64-apple-macos14.0" };
  }
  if (platform === "darwin" && requestedTarget === "x86_64-apple-darwin") {
    return { id: "darwin-x64", rustTarget: requestedTarget, swiftTarget: "x86_64-apple-macos14.0" };
  }
  if (platform === "darwin" && arch === "x64" && !requestedTarget) return { id: "darwin-x64" };
  if (platform === "darwin" && arch === "arm64" && !requestedTarget) return { id: "darwin-arm64" };
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
  copyFileSync(MAC_CURSOR_ASSET_SOURCE, resolve(resourcesDir, MAC_CURSOR_ASSET_NAME));
  buildMacBundleIcon(resourcesDir);
  const infoPlistPath = resolve(contentsDir, "Info.plist");
  writeFileSync(infoPlistPath, macInfoPlist());
  lintMacInfoPlist(infoPlistPath);
  buildMacCursorOverlay(resolve(macosDir, MAC_CURSOR_OVERLAY_BINARY_NAME));
  buildMacPermissionGuide(resolve(macosDir, MAC_PERMISSION_GUIDE_BINARY_NAME));
  buildMacScreenCapture(resolve(macosDir, MAC_SCREEN_CAPTURE_BINARY_NAME));
  buildMacEventMonitor(resolve(macosDir, MAC_EVENT_MONITOR_BINARY_NAME));
  buildMacAppDiscovery(resolve(macosDir, MAC_APP_DISCOVERY_BINARY_NAME));
  signMacAppBundle(appRoot);
  console.error(`[desktop-host] wrote ${appRoot}`);
}

function buildMacBundleIcon(resourcesDir) {
  const iconsetDir = resolve(resourcesDir, MAC_BUNDLE_ICONSET_NAME);
  rmSync(iconsetDir, { recursive: true, force: true });
  mkdirSync(iconsetDir, { recursive: true });
  for (const [fileName, pixelSize] of MAC_BUNDLE_ICON_ENTRIES) {
    const result = spawnSync("sips", [
      "-z",
      String(pixelSize),
      String(pixelSize),
      MAC_CURSOR_ASSET_SOURCE,
      "--out",
      resolve(iconsetDir, fileName),
    ], {
      cwd: REPO_ROOT,
      stdio: "inherit",
    });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
  const result = spawnSync("iconutil", [
    "-c",
    "icns",
    iconsetDir,
    "-o",
    resolve(resourcesDir, MAC_BUNDLE_ICON_NAME),
  ], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  rmSync(iconsetDir, { recursive: true, force: true });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function lintMacInfoPlist(infoPlistPath) {
  const result = spawnSync("plutil", ["-lint", infoPlistPath], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function buildMacCursorOverlay(outputPath) {
  const result = spawnSync("xcrun", [
    "swiftc",
    "-parse-as-library",
    ...macSwiftTargetArgs(),
    MAC_CURSOR_OVERLAY_SOURCE,
    "-o",
    outputPath,
    "-framework",
    "AppKit",
  ], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
  chmodSync(outputPath, 0o755);
}

function buildMacPermissionGuide(outputPath) {
  const result = spawnSync("xcrun", [
    "swiftc",
    "-parse-as-library",
    ...macSwiftTargetArgs(),
    MAC_PERMISSION_GUIDE_SOURCE,
    "-o",
    outputPath,
    "-framework",
    "AppKit",
  ], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
  chmodSync(outputPath, 0o755);
}

function buildMacScreenCapture(outputPath) {
  const result = spawnSync("xcrun", [
    "swiftc",
    "-parse-as-library",
    ...macSwiftTargetArgs(),
    MAC_SCREEN_CAPTURE_SOURCE,
    "-o",
    outputPath,
    "-framework",
    "AppKit",
    "-framework",
    "ScreenCaptureKit",
  ], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
  chmodSync(outputPath, 0o755);
}

function buildMacEventMonitor(outputPath) {
  const result = spawnSync("xcrun", [
    "swiftc",
    "-parse-as-library",
    ...macSwiftTargetArgs(),
    MAC_EVENT_MONITOR_SOURCE,
    "-o",
    outputPath,
    "-framework",
    "AppKit",
    "-framework",
    "ApplicationServices",
  ], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
  chmodSync(outputPath, 0o755);
}

function buildMacAppDiscovery(outputPath) {
  const result = spawnSync("xcrun", [
    "swiftc",
    "-parse-as-library",
    ...macSwiftTargetArgs(),
    MAC_APP_DISCOVERY_SOURCE,
    "-o",
    outputPath,
    "-framework",
    "AppKit",
    "-framework",
    "CoreServices",
  ], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
  chmodSync(outputPath, 0o755);
}

function macSwiftTargetArgs() {
  return TARGET.swiftTarget ? ["-target", TARGET.swiftTarget] : [];
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
  <key>CFBundleIconFile</key>
  <string>${MAC_BUNDLE_ICON_NAME}</string>
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
  <key>NSPrincipalClass</key>
  <string>NSApplication</string>
  <key>LumeComputerUseAppVariant</key>
  <string>${MAC_BUNDLE_VARIANT}</string>
</dict>
</plist>
`;
}

function signMacAppBundle(appRoot) {
  const mode = process.env.LUME_COMPUTER_USE_CODESIGN_MODE ?? "auto";
  if (!["auto", "identity", "adhoc", "none"].includes(mode)) {
    throw new Error(`unsupported LUME_COMPUTER_USE_CODESIGN_MODE: ${mode}`);
  }
  const identity = resolveMacCodesignIdentity(mode);
  if (REQUIRE_STABLE_SIGNING && (!identity || identity === "-")) {
    throw new Error("release packaging requires a stable macOS signing identity for Lume Computer Use.app");
  }
  if (!identity) {
    console.error(`[desktop-host] skipped codesign for ${appRoot}`);
    return;
  }
  const args = ["--force", "--deep", "--sign", identity];
  if (identity !== "-") {
    args.push("--options", "runtime");
  }
  args.push(appRoot);
  const result = spawnSync("codesign", args, {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
  if (identity === "-") {
    console.error("[desktop-host] signed with ad-hoc identity; macOS TCC may treat rebuilt app bundles as different authorization subjects");
  }
}

function resolveMacCodesignIdentity(mode) {
  const configuredIdentity = process.env.LUME_COMPUTER_USE_CODESIGN_IDENTITY?.trim();
  if (mode === "none") return undefined;
  if (mode === "adhoc") return "-";
  if (mode === "identity") {
    if (!configuredIdentity) {
      throw new Error("LUME_COMPUTER_USE_CODESIGN_IDENTITY is required when codesign mode is identity");
    }
    return configuredIdentity;
  }
  if (configuredIdentity) return configuredIdentity;
  return findMacCodesignIdentity("Developer ID Application")
    ?? findMacCodesignIdentity("Apple Development")
    ?? "-";
}

function findMacCodesignIdentity(prefix) {
  const result = spawnSync("security", ["find-identity", "-v", "-p", "codesigning"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  if (result.status !== 0) return undefined;
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = line.match(/"([^"]+)"/);
    if (match?.[1]?.startsWith(`${prefix}:`)) return match[1];
  }
  return undefined;
}

function signWindowsBinary(binaryPath) {
  const signTool = process.env.LUME_WINDOWS_SIGNTOOL_PATH?.trim();
  const certificatePath = process.env.LUME_WINDOWS_CODESIGN_CERTIFICATE?.trim();
  const certificatePassword = process.env.LUME_WINDOWS_CODESIGN_PASSWORD;
  if (!signTool || !certificatePath || !certificatePassword) {
    throw new Error("release packaging requires signtool and an Authenticode certificate for the Windows desktop host");
  }
  const sign = spawnSync(signTool, [
    "sign",
    "/fd",
    "SHA256",
    "/td",
    "SHA256",
    "/tr",
    "http://timestamp.digicert.com",
    "/f",
    certificatePath,
    "/p",
    certificatePassword,
    binaryPath,
  ], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  if (sign.status !== 0) process.exit(sign.status ?? 1);
  const verify = spawnSync(signTool, ["verify", "/pa", "/all", binaryPath], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  if (verify.status !== 0) process.exit(verify.status ?? 1);
}
