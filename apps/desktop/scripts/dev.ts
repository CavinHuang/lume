import { request } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensureElectronRuntimeInstalled,
  resolveElectronPackageRoot,
} from "./electron-runtime.mjs";
import { getNativeBinaryPath } from "../src/sidecar-process";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const devServerUrl = process.env.LUME_DESKTOP_DEV_SERVER_URL?.trim() || "http://127.0.0.1:3000";
const buildDesktopRuntimeScript = resolve(desktopRoot, "scripts", "build.ts");
const buildSidecarBundleScript = resolve(desktopRoot, "..", "..", "scripts", "build-sidecar-bundle.mjs");
const buildNativesBinaryScript = resolve(desktopRoot, "..", "..", "scripts", "build-natives-binary.mjs");
const buildNodeReplResourcesScript = resolve(desktopRoot, "..", "..", "scripts", "build-node-repl-resources.mjs");

let child = null;
let stopping = false;

async function waitForServer(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const reachable = await new Promise((resolveReachable) => {
      const req = request(url, { method: "GET" }, (res) => {
        res.resume();
        resolveReachable(Boolean(res.statusCode && res.statusCode < 500));
      });
      req.on("error", () => resolveReachable(false));
      req.end();
    });

    if (reachable) return;
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 500));
  }

  throw new Error(`timed out waiting for web dev server: ${url}`);
}

function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  if (child && !child.killed) {
    child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(code), 100);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => shutdown(0));
}

await waitForServer(devServerUrl);

const electronBin = await ensureElectronRuntimeInstalled({
  electronPackageRoot: resolveElectronPackageRoot(import.meta.url),
  log: (message) => console.error(`[desktop-dev] ${message}`),
});

const nativeBinaryPath = getNativeBinaryPath({
  appIsPackaged: false,
  resourcesPath: "",
  desktopRoot,
});
if (!existsSync(nativeBinaryPath)) {
  console.error(`[desktop-dev] native binary missing, building: ${nativeBinaryPath}`);
  const nativesResult = spawnSync("bun", [buildNativesBinaryScript], {
    cwd: resolve(desktopRoot, "..", ".."),
    stdio: "inherit",
  });
  if (nativesResult.status !== 0) {
    process.exit(nativesResult.status ?? 1);
  }
}

const desktopBuildResult = spawnSync("bun", [buildDesktopRuntimeScript], {
  cwd: desktopRoot,
  stdio: "inherit",
});
if (desktopBuildResult.status !== 0) {
  process.exit(desktopBuildResult.status ?? 1);
}

const bundleResult = spawnSync("bun", [buildSidecarBundleScript], {
  cwd: resolve(desktopRoot, "..", ".."),
  stdio: "inherit",
});
if (bundleResult.status !== 0) {
  process.exit(bundleResult.status ?? 1);
}

const nodeReplResourcesResult = spawnSync("node", [buildNodeReplResourcesScript], {
  cwd: resolve(desktopRoot, "..", ".."),
  stdio: "inherit",
});
if (nodeReplResourcesResult.status !== 0) {
  process.exit(nodeReplResourcesResult.status ?? 1);
}

child = spawn(electronBin, [desktopRoot], {
  cwd: desktopRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    LUME_DESKTOP_DEV_SERVER_URL: devServerUrl,
  },
});

child.on("exit", (code, signal) => {
  if (stopping) {
    process.exit(code ?? 0);
    return;
  }

  if (signal) {
    console.error(`[desktop-dev] electron terminated by signal ${signal}`);
    process.exit(1);
    return;
  }

  process.exit(code ?? 0);
});
