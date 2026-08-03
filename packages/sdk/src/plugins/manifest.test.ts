import { describe, expect, test } from "bun:test";
import { parseManifest, inferDefaults, validateManifest } from "./manifest.js";

describe("LumePluginManifest", () => {
  test("parses a minimal valid manifest", () => {
    const raw = {
      schema: "lume-plugin/v1",
      name: "my-plugin",
      version: "1.0.0",
    };
    const result = parseManifest(raw);
    expect(result.schema).toBe("lume-plugin/v1");
    expect(result.name).toBe("my-plugin");
    expect(result.version).toBe("1.0.0");
  });

  test("injects default values for optional fields", () => {
    const raw = {
      schema: "lume-plugin/v1",
      name: "my-plugin",
      version: "1.0.0",
    };
    const result = inferDefaults(raw);
    expect(result.permissions).toBeDefined();
    expect(result.permissions.filesystem.read).toEqual(["./**"]);
    expect(result.permissions.filesystem.write).toEqual(["./data/**"]);
    expect(result.permissions.network.outbound).toEqual([]);
    expect(result.permissions.mcpServers.register).toBe(false);
    expect(result.permissions.shell.allow).toBe(false);
    expect(result.lume).toBeDefined();
    expect(result.lume.hooksOnly).toBe(false);
  });

  test("rejects invalid name (uppercase)", () => {
    const raw = {
      schema: "lume-plugin/v1",
      name: "My-Plugin",
      version: "1.0.0",
    };
    expect(() => parseManifest(raw)).toThrow("name");
  });

  test("rejects name exceeding 64 chars", () => {
    const raw = {
      schema: "lume-plugin/v1",
      name: "a".repeat(65),
      version: "1.0.0",
    };
    expect(() => parseManifest(raw)).toThrow("name");
  });

  test("rejects path without ./ prefix", () => {
    const raw = {
      schema: "lume-plugin/v1",
      name: "my-plugin",
      version: "1.0.0",
      skills: "skills/",
    };
    expect(() => parseManifest(raw)).toThrow("skills");
  });

  test("rejects path with parent directory traversal", () => {
    const raw = {
      schema: "lume-plugin/v1",
      name: "my-plugin",
      version: "1.0.0",
      hooks: "./hooks/../secret.json",
    };
    expect(() => parseManifest(raw)).toThrow("hooks");
  });

  test("validates plugin LSP config as a package-relative path", () => {
    expect(parseManifest({
      schema: "lume-plugin/v1",
      name: "my-plugin",
      version: "1.0.0",
      lspServers: "./lsp.yaml",
    }).lspServers).toBe("./lsp.yaml");
    expect(() => parseManifest({
      schema: "lume-plugin/v1",
      name: "my-plugin",
      version: "1.0.0",
      lspServers: "../lsp.yaml",
    })).toThrow("lspServers");
  });

  test("validates version is semver-like", () => {
    const raw = {
      schema: "lume-plugin/v1",
      name: "my-plugin",
      version: "not-a-version",
    };
    expect(() => parseManifest(raw)).toThrow("version");
  });

  test("accepts skills as array of paths", () => {
    const raw = {
      schema: "lume-plugin/v1",
      name: "my-plugin",
      version: "1.0.0",
      skills: ["./skills-a/", "./skills-b/"],
    };
    const result = parseManifest(raw);
    expect(result.skills).toEqual(["./skills-a/", "./skills-b/"]);
  });

  test("validates permissions field structure", () => {
    const raw = {
      schema: "lume-plugin/v1",
      name: "my-plugin",
      version: "1.0.0",
      permissions: {
        tools: {
          allow: ["Bash", "FileWrite"],
        },
      },
    };
    const result = parseManifest(raw);
    expect(result.permissions.tools.allow).toEqual(["Bash", "FileWrite"]);
    expect(result.permissions.tools.deny).toBeUndefined();
  });

  test("parses raw command tool entries for the normalizer", () => {
    const manifest = parseManifest({
      schema: "lume-plugin/v1",
      name: "tools",
      version: "1.0.0",
      commandTools: [{ name: "echo", command: "echo" }],
    });

    expect(manifest.commandTools).toEqual([{ name: "echo", command: "echo" }]);
  });

  test("parses marketplace metadata", () => {
    const manifest = parseManifest({
      schema: "lume-plugin/v1",
      name: "market-plugin",
      version: "1.0.0",
      marketplace: {
        icon: "./assets/icon.svg",
        thumbnail: "./assets/thumbnail.svg",
        hero: "./assets/hero.png",
        docs: "./README.md",
        website: "https://example.com/plugin",
        setup: [
          {
            id: "install",
            title: "Install",
            description: "Install the companion app.",
            kind: "install",
          },
          {
            id: "ignored",
            title: "Ignored",
            description: "Unknown setup kind falls back to custom.",
            kind: "unknown",
          },
        ],
      },
    });

    expect(manifest.marketplace).toEqual({
      icon: "./assets/icon.svg",
      thumbnail: "./assets/thumbnail.svg",
      hero: "./assets/hero.png",
      docs: "./README.md",
      website: "https://example.com/plugin",
      setup: [
        {
          id: "install",
          title: "Install",
          description: "Install the companion app.",
          kind: "install",
        },
        {
          id: "ignored",
          title: "Ignored",
          description: "Unknown setup kind falls back to custom.",
        },
      ],
    });
  });

  test("rejects marketplace asset paths outside the plugin package", () => {
    expect(() => parseManifest({
      schema: "lume-plugin/v1",
      name: "bad-market-plugin",
      version: "1.0.0",
      marketplace: { thumbnail: "../outside.png" },
    })).toThrow("marketplace.thumbnail");
  });
});

describe("PluginMarketplaceSetupStep bridge fields", () => {
  test("解析 artifact/download/build/targetApp/verify 字段", () => {
    const parsed = parseManifest({
      schema: "lume-plugin/v1",
      name: "demo",
      version: "1.0.0",
      marketplace: {
        setup: [
          {
            id: "install-ext",
            title: "安装扩展",
            description: "加载已解包扩展",
            kind: "install",
            artifact: { path: "./ext.zip", kind: "chrome-extension" },
            download: { url: "https://example.com/asset.zip", filename: "asset.zip" },
            build: { command: "cargo build --release", cwd: "./host", prerequisites: "需 Rust" },
            targetApp: { kind: "chrome", installHint: "chrome://extensions" },
            verify: { method: "chrome-extension", detail: "abcdefg" },
          },
        ],
      },
    });
    const step = parsed.marketplace!.setup![0];
    expect(step.artifact).toEqual({ path: "./ext.zip", kind: "chrome-extension" });
    expect(step.download).toEqual({ url: "https://example.com/asset.zip", filename: "asset.zip" });
    expect(step.build).toEqual({ command: "cargo build --release", cwd: "./host", prerequisites: "需 Rust" });
    expect(step.targetApp).toEqual({ kind: "chrome", installHint: "chrome://extensions" });
    expect(step.verify).toEqual({ method: "chrome-extension", detail: "abcdefg" });
  });

  test("拒绝非 https 的 download.url（丢弃 download 字段）", () => {
    const parsed = parseManifest({
      schema: "lume-plugin/v1",
      name: "demo",
      version: "1.0.0",
      marketplace: {
        setup: [{ id: "s1", title: "t", description: "d", download: { url: "http://insecure.com/a.zip" } }],
      },
    });
    expect(parsed.marketplace!.setup![0].download).toBeUndefined();
  });

  test("解析按平台分发的 Native Host 安装器", () => {
    const parsed = parseManifest({
      schema: "lume-plugin/v1",
      name: "browser",
      version: "1.0.0",
      marketplace: {
        setup: [{
          id: "install-host",
          title: "安装 Host",
          description: "安装预编译 Host",
          kind: "install",
          artifacts: [
            { path: "./runtime/win32-x64/host.exe", kind: "native-binary", platform: "win32", arch: "x64" },
            { path: "./runtime/darwin-arm64/host", kind: "native-binary", platform: "darwin", arch: "arm64" },
          ],
          installer: {
            kind: "chrome-native-host",
            hostName: "com.lume.browser",
            extensionId: "abcdefghijklmnopabcdefghijklmnop",
            appServerUrl: "ws://127.0.0.1:43127/browser",
          },
        }],
      },
    });
    const step = parsed.marketplace!.setup![0];
    expect(step.artifacts).toHaveLength(2);
    expect(step.artifacts![0]).toEqual({
      path: "./runtime/win32-x64/host.exe",
      kind: "native-binary",
      platform: "win32",
      arch: "x64",
    });
    expect(step.installer).toEqual({
      kind: "chrome-native-host",
      hostName: "com.lume.browser",
      extensionId: "abcdefghijklmnopabcdefghijklmnop",
      appServerUrl: "ws://127.0.0.1:43127/browser",
    });
  });

  test("拒绝非回环地址的 Native Host 安装器", () => {
    const parsed = parseManifest({
      schema: "lume-plugin/v1",
      name: "browser",
      version: "1.0.0",
      marketplace: {
        setup: [{
          id: "install-host",
          title: "安装 Host",
          description: "invalid",
          artifact: { path: "./host", kind: "native-binary" },
          installer: {
            kind: "chrome-native-host",
            hostName: "com.lume.browser",
            extensionId: "abcdefghijklmnopabcdefghijklmnop",
            appServerUrl: "wss://example.com/browser",
          },
        }],
      },
    });
    expect(parsed.marketplace?.setup?.length ?? 0).toBe(0);
  });

  test("拒绝非法 Native Host 名称", () => {
    for (const hostName of ["com.lume-browser", ".", "..", ".com.lume", "com..lume", "com.lume."]) {
      const parsed = parseManifest({
        schema: "lume-plugin/v1",
        name: "browser",
        version: "1.0.0",
        marketplace: {
          setup: [{
            id: "install-host",
            title: "安装 Host",
            description: "invalid",
            artifact: { path: "./host", kind: "native-binary" },
            installer: {
              kind: "chrome-native-host",
              hostName,
              extensionId: "abcdefghijklmnopabcdefghijklmnop",
              appServerUrl: "ws://127.0.0.1:43127/browser",
            },
          }],
        },
      });
      expect(parsed.marketplace?.setup?.length ?? 0).toBe(0);
    }
  });

  test("拒绝含 .. 的 artifact.path（整步丢弃）", () => {
    const parsed = parseManifest({
      schema: "lume-plugin/v1",
      name: "demo",
      version: "1.0.0",
      marketplace: {
        setup: [{ id: "s1", title: "t", description: "d", artifact: { path: "./../escape.zip", kind: "file" } }],
      },
    });
    // path 非法则该步被丢弃（validatePluginPath 抛错被 flatMap 捕获为空）
    // 注：该步丢弃后 setup 为空，normalizeMarketplace 整体返回 undefined（marketplace 无其他字段），
    // 故此处用可选链访问 marketplace（brief 原文为 non-null 断言 `!`，会触发 TypeError）。
    expect(parsed.marketplace?.setup?.length ?? 0).toBe(0);
  });

  test("无新字段的旧 setup step 仍正常解析", () => {
    const parsed = parseManifest({
      schema: "lume-plugin/v1",
      name: "demo",
      version: "1.0.0",
      marketplace: { setup: [{ id: "s1", title: "t", description: "d", kind: "install" }] },
    });
    expect(parsed.marketplace!.setup).toEqual([{ id: "s1", title: "t", description: "d", kind: "install" }]);
  });
});
