/**
 * Migrated from:
 * /Users/cavinhuang/workspace/projects/test/openclaw/src/cli/browser-cli-extension.ts
 * Adaptation:
 * - 迁移为 Lume sidecar service，负责浏览器扩展目录解析/安装。
 * - 统一安装到 `~/.lume/browser/chrome-extension` 稳定目录。
 * - 暴露 extension 引导信息供 browser tool 直接返回。
 */

import { cp, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getConfigDir } from "../infra/config-paths";

const DEFAULT_RELAY_PORT = 18792;
const EXTENSION_SUBPATH = join("browser", "chrome-extension");

function hasManifest(dir: string): boolean {
  return existsSync(join(dir, "manifest.json"));
}

function resolveBundledExtensionDir(): string | null {
  const fromEnv = process.env.LUME_CHROME_EXTENSION_SOURCE_DIR?.trim();
  if (fromEnv) {
    const sourceDir = resolve(fromEnv);
    return hasManifest(sourceDir) ? sourceDir : null;
  }

  const fromCwd = resolve(join(process.cwd(), "assets", "chrome-extension"));
  if (hasManifest(fromCwd)) {
    return fromCwd;
  }

  return null;
}

export function getInstalledExtensionDir(): string {
  return join(getConfigDir(), EXTENSION_SUBPATH);
}

function resolveRelayPort(): number {
  const raw = process.env.LUME_BROWSER_RELAY_PORT?.trim();
  if (!raw) return DEFAULT_RELAY_PORT;
  const port = Number.parseInt(raw, 10);
  return Number.isFinite(port) && port > 0 && port <= 65535 ? port : DEFAULT_RELAY_PORT;
}

export interface ChromeExtensionInfo {
  installedPath: string;
  installed: boolean;
  bundledPath: string | null;
  bundledAvailable: boolean;
  relay: {
    port: number;
    httpUrl: string;
    wsUrl: string;
    tokenRequired: boolean;
  };
  links: {
    chromeExtensions: string;
    chromeLoadUnpackedHint: string;
  };
}

export function getChromeExtensionInfo(): ChromeExtensionInfo {
  const installedPath = getInstalledExtensionDir();
  const bundledPath = resolveBundledExtensionDir();
  const relayPort = resolveRelayPort();
  const relayHttpUrl = `http://127.0.0.1:${relayPort}/`;

  return {
    installedPath,
    installed: hasManifest(installedPath),
    bundledPath,
    bundledAvailable: bundledPath !== null,
    relay: {
      port: relayPort,
      httpUrl: relayHttpUrl,
      wsUrl: `ws://127.0.0.1:${relayPort}/extension`,
      tokenRequired: Boolean(process.env.LUME_BROWSER_RELAY_TOKEN?.trim()),
    },
    links: {
      chromeExtensions: "chrome://extensions/",
      chromeLoadUnpackedHint: "chrome://extensions/ -> Developer mode -> Load unpacked",
    },
  };
}

export async function installChromeExtension(): Promise<{ path: string }> {
  const sourceDir = resolveBundledExtensionDir();
  if (!sourceDir) {
    throw new Error("未找到内置 Chrome extension（缺少 manifest.json）");
  }

  const targetDir = getInstalledExtensionDir();
  await mkdir(dirname(targetDir), { recursive: true });

  if (existsSync(targetDir)) {
    await rm(targetDir, { recursive: true, force: true });
  }

  await cp(sourceDir, targetDir, { recursive: true });
  if (!hasManifest(targetDir)) {
    throw new Error("Chrome extension 安装失败：目标目录缺少 manifest.json");
  }

  return { path: targetDir };
}
