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
});
