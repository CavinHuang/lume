import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginPackageService } from "./plugin-package-service";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "lume-plugin-package-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("PluginPackageService", () => {
  test("prepares an exact file and consumes its owner-bound token once", async () => {
    const root = tempRoot();
    const source = join(root, "plugin");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "extension.zip"), "package-bytes");
    const preparedRoot = join(root, "prepared");
    mkdirSync(join(preparedRoot, "orphaned-after-restart"), { recursive: true });
    writeFileSync(join(preparedRoot, "orphaned-after-restart", "partial.bin"), "partial");
    const service = new PluginPackageService(preparedRoot);

    const prepared = await service.preparePath({
      packageRoot: source,
      sourcePath: join(source, "extension.zip"),
      source: "local",
      ownerWebContentsId: 7,
      ownerGeneration: 3,
    });

    expect(prepared.kind).toBe("file");
    expect(prepared.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(existsSync(join(preparedRoot, "orphaned-after-restart"))).toBe(false);
    await expect(service.finalize({
      token: prepared.token,
      ownerWebContentsId: 8,
      ownerGeneration: 3,
      targetPath: join(root, "out.zip"),
    })).rejects.toThrow(/不属于当前窗口/);

    await service.finalize({
      token: prepared.token,
      ownerWebContentsId: 7,
      ownerGeneration: 3,
      targetPath: join(root, "out.zip"),
    });
    expect(readFileSync(join(root, "out.zip"), "utf8")).toBe("package-bytes");
    await expect(service.finalize({
      token: prepared.token,
      ownerWebContentsId: 7,
      ownerGeneration: 3,
      targetPath: join(root, "again.zip"),
    })).rejects.toThrow(/token 不存在/);
  });

  test("replaces an existing directory as a whole", async () => {
    const root = tempRoot();
    const source = join(root, "plugin", "obsidian-package");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "main.js"), "new");
    const target = join(root, "vault", "obsidian-package");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "obsolete.js"), "old");
    const service = new PluginPackageService(join(root, "prepared"));
    const prepared = await service.preparePath({
      packageRoot: join(root, "plugin"),
      sourcePath: source,
      source: "local",
      ownerWebContentsId: 1,
      ownerGeneration: 1,
    });

    await service.finalize({
      token: prepared.token,
      ownerWebContentsId: 1,
      ownerGeneration: 1,
      targetPath: target,
      overwrite: true,
    });

    expect(readFileSync(join(target, "main.js"), "utf8")).toBe("new");
    expect(existsSync(join(target, "obsolete.js"))).toBe(false);
  });

  test("rejects traversal and official downloads without SHA-256", async () => {
    const root = tempRoot();
    const source = join(root, "plugin");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(root, "outside.zip"), "outside");
    const service = new PluginPackageService(join(root, "prepared"));

    await expect(service.preparePath({
      packageRoot: source,
      sourcePath: join(root, "outside.zip"),
      source: "local",
      ownerWebContentsId: 1,
      ownerGeneration: 1,
    })).rejects.toThrow(/路径越界/);

    await expect(service.prepareDownload({
      url: "https://example.com/package.zip",
      requireSha256: true,
      source: "official-market",
      ownerWebContentsId: 1,
      ownerGeneration: 1,
    })).rejects.toThrow(/缺少 SHA-256/);
  });
});
