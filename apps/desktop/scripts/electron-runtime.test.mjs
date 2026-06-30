import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ensureElectronRuntimeInstalled,
  getElectronPlatformPath,
  isElectronRuntimeInstalled,
  resolveElectronExecutablePath,
} from "./electron-runtime.mjs";

async function createTempElectronPackage() {
  return mkdtemp(join(tmpdir(), "lume-electron-runtime-"));
}

test("resolves the real Electron runtime path instead of the npm CLI shim", async () => {
  const electronPackageRoot = await createTempElectronPackage();

  try {
    await mkdir(join(electronPackageRoot, "dist"), { recursive: true });
    await writeFile(join(electronPackageRoot, "dist", "version"), "42.5.0");
    await writeFile(join(electronPackageRoot, "path.txt"), "electron.exe");
    await writeFile(join(electronPackageRoot, "dist", "electron.exe"), "");

    assert.equal(getElectronPlatformPath("win32"), "electron.exe");
    assert.equal(
      resolveElectronExecutablePath({ electronPackageRoot, platform: "win32" }),
      join(electronPackageRoot, "dist", "electron.exe"),
    );
    assert.equal(
      isElectronRuntimeInstalled({ electronPackageRoot, version: "42.5.0", platform: "win32" }),
      true,
    );
  } finally {
    await rm(electronPackageRoot, { recursive: true, force: true });
  }
});

test("installs Electron runtime through ESM-safe download helpers when dist is missing", async () => {
  const electronPackageRoot = await createTempElectronPackage();
  const zipPath = join(electronPackageRoot, "electron.zip");
  const calls = {};

  try {
    await writeFile(join(electronPackageRoot, "checksums.json"), JSON.stringify({ "electron.zip": "sha256" }));
    await writeFile(zipPath, "");

    const executablePath = await ensureElectronRuntimeInstalled({
      electronPackageRoot,
      version: "42.5.0",
      platform: "win32",
      arch: "x64",
      env: {},
      downloadArtifact: async (options) => {
        calls.download = options;
        return zipPath;
      },
      extract: async (source, options) => {
        calls.extract = { source, options };
        await mkdir(options.dir, { recursive: true });
        await writeFile(join(options.dir, "version"), "42.5.0");
        await writeFile(join(options.dir, "electron.exe"), "");
      },
    });

    assert.equal(executablePath, join(electronPackageRoot, "dist", "electron.exe"));
    assert.equal(await readFile(join(electronPackageRoot, "path.txt"), "utf8"), "electron.exe");
    assert.equal(calls.download.version, "42.5.0");
    assert.equal(calls.download.artifactName, "electron");
    assert.equal(calls.download.platform, "win32");
    assert.equal(calls.download.arch, "x64");
    assert.deepEqual(calls.download.mirrorOptions, { mirror: "https://npmmirror.com/mirrors/electron/" });
    assert.equal(calls.extract.source, zipPath);
    assert.equal(calls.extract.options.dir, join(electronPackageRoot, "dist"));
  } finally {
    await rm(electronPackageRoot, { recursive: true, force: true });
  }
});
