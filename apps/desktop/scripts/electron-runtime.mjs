import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export function getElectronPlatformPath(platform = process.platform) {
  switch (platform) {
    case "mas":
    case "darwin":
      return "Electron.app/Contents/MacOS/Electron";
    case "freebsd":
    case "openbsd":
    case "linux":
      return "electron";
    case "win32":
      return "electron.exe";
    default:
      throw new Error(`Electron builds are not available on platform: ${platform}`);
  }
}

export function resolveElectronExecutablePath({ electronPackageRoot, platform = process.platform }) {
  return join(electronPackageRoot, "dist", getElectronPlatformPath(platform));
}

export function resolveElectronPackageRoot(fromUrl = import.meta.url) {
  return createRequire(fromUrl).resolve("electron/package.json").replace(/[\\/]package\.json$/, "");
}

export function readElectronPackageVersion(electronPackageRoot) {
  return JSON.parse(readFileSync(join(electronPackageRoot, "package.json"), "utf8")).version;
}

export function isElectronRuntimeInstalled({
  electronPackageRoot,
  version,
  platform = process.platform,
  fileExists = existsSync,
  readText = (path) => readFileSync(path, "utf8"),
}) {
  const platformPath = getElectronPlatformPath(platform);

  try {
    if (readText(join(electronPackageRoot, "dist", "version")).replace(/^v/, "") !== version) {
      return false;
    }

    if (readText(join(electronPackageRoot, "path.txt")) !== platformPath) {
      return false;
    }
  } catch {
    return false;
  }

  return fileExists(resolveElectronExecutablePath({ electronPackageRoot, platform }));
}

export function resolveElectronInstallArch({
  platform = process.platform,
  arch = process.arch,
  npmConfigArch = process.env.npm_config_arch,
  exec = execSync,
} = {}) {
  if (platform !== "darwin" || process.platform !== "darwin" || arch !== "x64" || npmConfigArch !== undefined) {
    return arch;
  }

  try {
    return exec("sysctl -in sysctl.proc_translated").toString().trim() === "1" ? "arm64" : arch;
  } catch {
    return arch;
  }
}

export function resolveElectronMirrorOptions(env = process.env) {
  return {
    mirror: env.ELECTRON_MIRROR?.trim()
      || env.npm_config_electron_mirror?.trim()
      || env.NPM_CONFIG_ELECTRON_MIRROR?.trim()
      || "https://npmmirror.com/mirrors/electron/",
  };
}

async function loadElectronInstallDependencies(electronPackageRoot) {
  const requireFromElectron = createRequire(join(electronPackageRoot, "package.json"));
  const electronGetPath = requireFromElectron.resolve("@electron/get");
  const extractZipPath = requireFromElectron.resolve("@electron-internal/extract-zip");
  const electronGet = await import(pathToFileURL(electronGetPath).href);
  const extractZip = await import(pathToFileURL(extractZipPath).href);

  return {
    downloadArtifact: electronGet.downloadArtifact,
    extract: extractZip.extract ?? extractZip.default,
  };
}

export async function ensureElectronRuntimeInstalled({
  electronPackageRoot,
  version = readElectronPackageVersion(electronPackageRoot),
  platform = process.env.ELECTRON_INSTALL_PLATFORM || process.env.npm_config_platform || process.platform,
  arch = resolveElectronInstallArch({
    platform,
    arch: process.env.ELECTRON_INSTALL_ARCH || process.env.npm_config_arch || process.arch,
    npmConfigArch: process.env.npm_config_arch,
  }),
  env = process.env,
  downloadArtifact,
  extract,
  log = () => {},
} = {}) {
  if (!electronPackageRoot) {
    throw new Error("electronPackageRoot is required");
  }

  if (isElectronRuntimeInstalled({ electronPackageRoot, version, platform })) {
    return resolveElectronExecutablePath({ electronPackageRoot, platform });
  }

  log(`installing Electron ${version} runtime for ${platform}/${arch}`);

  if (!downloadArtifact || !extract) {
    ({ downloadArtifact, extract } = await loadElectronInstallDependencies(electronPackageRoot));
  }

  const distPath = join(electronPackageRoot, "dist");
  const platformPath = getElectronPlatformPath(platform);
  const checksums = env.electron_use_remote_checksums || env.npm_config_electron_use_remote_checksums
    ? undefined
    : JSON.parse(readFileSync(join(electronPackageRoot, "checksums.json"), "utf8"));
  const zipPath = await downloadArtifact({
    version,
    artifactName: "electron",
    force: env.force_no_cache === "true",
    cacheRoot: env.electron_config_cache,
    checksums,
    platform,
    arch,
    mirrorOptions: resolveElectronMirrorOptions(env),
  });

  await mkdir(distPath, { recursive: true });
  await extract(zipPath, { dir: distPath });

  const srcTypeDefPath = join(distPath, "electron.d.ts");
  const targetTypeDefPath = join(electronPackageRoot, "electron.d.ts");
  if (existsSync(srcTypeDefPath)) {
    await rename(srcTypeDefPath, targetTypeDefPath);
  }

  await writeFile(join(electronPackageRoot, "path.txt"), platformPath);

  return resolveElectronExecutablePath({ electronPackageRoot, platform });
}
