import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getChromeExtensionInfo,
  getInstalledExtensionDir,
  installChromeExtension
} from "./chrome-extension-manager";

describe("chrome-extension-manager", () => {
  const prevConfigDir = process.env.LUME_CONFIG_DIR;
  const prevSourceDir = process.env.LUME_CHROME_EXTENSION_SOURCE_DIR;
  const prevRelayPort = process.env.LUME_BROWSER_RELAY_PORT;
  const created: string[] = [];

  afterEach(() => {
    if (prevConfigDir === undefined) delete process.env.LUME_CONFIG_DIR;
    else process.env.LUME_CONFIG_DIR = prevConfigDir;
    if (prevSourceDir === undefined) delete process.env.LUME_CHROME_EXTENSION_SOURCE_DIR;
    else process.env.LUME_CHROME_EXTENSION_SOURCE_DIR = prevSourceDir;
    if (prevRelayPort === undefined) delete process.env.LUME_BROWSER_RELAY_PORT;
    else process.env.LUME_BROWSER_RELAY_PORT = prevRelayPort;
    for (const dir of created.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("安装扩展后应返回稳定路径并可被 extension_info 识别", async () => {
    const tempConfig = mkdtempSync(join(tmpdir(), "lume-browser-config-"));
    const tempSourceRoot = mkdtempSync(join(tmpdir(), "lume-browser-source-"));
    const tempSource = join(tempSourceRoot, "chrome-extension");
    created.push(tempConfig, tempSourceRoot);

    mkdirSync(tempSource, { recursive: true });
    writeFileSync(join(tempSource, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Lume", version: "0.1.0" }));
    writeFileSync(join(tempSource, "background.js"), "console.log('ok');");

    process.env.LUME_CONFIG_DIR = tempConfig;
    process.env.LUME_CHROME_EXTENSION_SOURCE_DIR = tempSource;
    process.env.LUME_BROWSER_RELAY_PORT = "19999";

    const install = await installChromeExtension();
    expect(install.path).toBe(getInstalledExtensionDir());

    const info = getChromeExtensionInfo();
    expect(info.installed).toBeTrue();
    expect(info.bundledAvailable).toBeTrue();
    expect(info.relay.port).toBe(19999);
    expect(info.relay.httpUrl).toBe("http://127.0.0.1:19999/");
    expect(info.relay.tokenRequired).toBeFalse();
    expect(info.links.chromeExtensions).toBe("chrome://extensions/");
  });
});
