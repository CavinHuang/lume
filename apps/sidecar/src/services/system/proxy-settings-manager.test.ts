import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  applyProxySettings,
  detectSystemProxySettings,
  parseMacSystemProxyOutput
} from "./proxy-settings-manager";

describe("proxy-settings-manager", () => {
  const originalEnv = {
    HTTP_PROXY: process.env.HTTP_PROXY,
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    NO_PROXY: process.env.NO_PROXY
  };

  beforeEach(() => {
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.NO_PROXY;
  });

  afterEach(() => {
    restoreEnv("HTTP_PROXY", originalEnv.HTTP_PROXY);
    restoreEnv("HTTPS_PROXY", originalEnv.HTTPS_PROXY);
    restoreEnv("NO_PROXY", originalEnv.NO_PROXY);
  });

  test("解析 macOS 系统代理输出为 curl/undici 可用的代理 URL", () => {
    expect(parseMacSystemProxyOutput([
      "<dictionary> {",
      "  HTTPEnable : 1",
      "  HTTPPort : 7890",
      "  HTTPProxy : 127.0.0.1",
      "  HTTPSEnable : 1",
      "  HTTPSPort : 7891",
      "  HTTPSProxy : proxy.local",
      "  ExceptionsList : <array> {",
      "    0 : localhost",
      "    1 : *.internal",
      "  }",
      "}"
    ].join("\n"))).toEqual({
      httpProxy: "http://127.0.0.1:7890",
      httpsProxy: "http://proxy.local:7891",
      noProxy: "localhost,*.internal"
    });
  });

  test("system 模式应用实时检测到的系统代理并写入运行时环境", async () => {
    await applyProxySettings({
      version: 1,
      enabled: true,
      mode: "system"
    }, {
      detectSystemProxy: () => ({
        httpProxy: "http://127.0.0.1:7890",
        httpsProxy: "http://127.0.0.1:7891",
        noProxy: "localhost,127.0.0.1"
      }),
      applyDispatcher: async () => {}
    });

    expect(process.env.HTTP_PROXY).toBe("http://127.0.0.1:7890");
    expect(process.env.HTTPS_PROXY).toBe("http://127.0.0.1:7891");
    expect(process.env.NO_PROXY).toBe("localhost,127.0.0.1");
  });

  test("非 macOS 平台检测系统代理时回退到环境变量", () => {
    const detected = detectSystemProxySettings({
      env: {
        HTTP_PROXY: "http://env-http:8080",
        HTTPS_PROXY: "http://env-https:8443",
        NO_PROXY: "localhost"
      },
      platform: "linux",
      execFileSync: () => {
        throw new Error("should not execute");
      }
    });

    expect(detected).toEqual({
      httpProxy: "http://env-http:8080",
      httpsProxy: "http://env-https:8443",
      noProxy: "localhost"
    });
  });

  test("macOS 系统代理检测优先使用绝对路径 scutil 以适配 GUI 应用环境", () => {
    const calls: string[] = [];
    const detected = detectSystemProxySettings({
      platform: "darwin",
      execFileSync: ((command: string) => {
        calls.push(command);
        return [
          "<dictionary> {",
          "  HTTPEnable : 1",
          "  HTTPPort : 7890",
          "  HTTPProxy : 127.0.0.1",
          "}"
        ].join("\n");
      }) as typeof import("node:child_process").execFileSync
    });

    expect(calls[0]).toBe("/usr/sbin/scutil");
    expect(detected.httpProxy).toBe("http://127.0.0.1:7890");
  });

  function restoreEnv(key: "HTTP_PROXY" | "HTTPS_PROXY" | "NO_PROXY", value: string | undefined): void {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});
