import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computePermissionsHash } from "./permissions-hash.js";
import type { NormalizedPlugin } from "./normalized.js";

function basePlugin(overrides: Partial<NormalizedPlugin> = {}): NormalizedPlugin {
  return {
    pluginId: "acme",
    name: "acme",
    version: "1.0.0",
    root: "/plugins/acme",
    manifestFormat: "lume",
    capabilities: { skills: [], commandTools: [] },
    permissions: {},
    diagnostics: [],
    ...overrides,
  };
}

describe("computePermissionsHash", () => {
  test("is deterministic for identical plugins and is a sha256 hex", () => {
    const a = computePermissionsHash(basePlugin());
    const b = computePermissionsHash(basePlugin());
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  test("excludes version: a pure version bump keeps the hash", () => {
    const v1 = computePermissionsHash(basePlugin({ version: "1.0.0" }));
    const v2 = computePermissionsHash(basePlugin({ version: "2.0.0" }));
    expect(v1).toBe(v2);
  });

  test("excludes installation root and diagnostics", () => {
    const a = computePermissionsHash(basePlugin({ root: "/plugins/acme" }));
    const b = computePermissionsHash(
      basePlugin({
        root: "/elsewhere/acme",
        diagnostics: [{ severity: "info", code: "legacy_manifest", message: "x" }],
      }),
    );
    expect(a).toBe(b);
  });

  test("changes when permissions change", () => {
    const before = computePermissionsHash(basePlugin());
    const after = computePermissionsHash(
      basePlugin({ permissions: { tools: { deny: ["Bash"] } } }),
    );
    expect(before).not.toBe(after);
  });

  test("changes when the hooks config content changes (#347)", () => {
    const root = mkdtempSync(join(tmpdir(), "lume-plugin-hooks-hash-"));
    try {
      mkdirSync(join(root, "hooks"));
      const path = join(root, "hooks", "hooks.json");
      const plugin = basePlugin({
        root,
        capabilities: { skills: [], commandTools: [], hooksConfigPath: "./hooks/hooks.json" },
      });
      writeFileSync(path, '{"PreToolUse":[{"command":"hook-a"}]}');
      const before = computePermissionsHash(plugin);
      writeFileSync(path, '{"PreToolUse":[{"command":"attacker-cmd"}]}');
      const after = computePermissionsHash(plugin);
      expect(before).not.toBe(after);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("changes when the MCP servers config content changes (#347)", () => {
    const root = mkdtempSync(join(tmpdir(), "lume-plugin-mcp-hash-"));
    try {
      const path = join(root, "mcp.json");
      const plugin = basePlugin({
        root,
        capabilities: { skills: [], commandTools: [], mcpServersConfigPath: "./mcp.json" },
      });
      writeFileSync(path, '{"servers":{"fs":{"command":"node","args":["a.js"]}}}');
      const before = computePermissionsHash(plugin);
      writeFileSync(path, '{"servers":{"fs":{"command":"node","args":["evil.js"]}}}');
      const after = computePermissionsHash(plugin);
      expect(before).not.toBe(after);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("is stable when hooks/mcp config files are absent", () => {
    const withHooks = basePlugin({
      capabilities: { skills: [], commandTools: [], hooksConfigPath: "./hooks/hooks.json" },
    });
    const a = computePermissionsHash(withHooks);
    const b = computePermissionsHash(withHooks);
    expect(a).toBe(b);
  });

  test("is order-independent for permission tool lists", () => {
    const denyAB = basePlugin({ permissions: { tools: { deny: ["Bash", "FileWrite"] } } });
    const denyBA = basePlugin({ permissions: { tools: { deny: ["FileWrite", "Bash"] } } });
    expect(computePermissionsHash(denyAB)).toBe(computePermissionsHash(denyBA));
  });

  test("is order-independent for skill roots and command tool names", () => {
    const orderedAB = basePlugin({
      capabilities: {
        skills: [
          { pluginId: "acme", version: "1.0.0", root: "/a" },
          { pluginId: "acme", version: "1.0.0", root: "/b" },
        ],
        commandTools: [
          { name: "zeta", command: "node" },
          { name: "alpha", command: "node" },
        ],
      },
    });
    const orderedBA = basePlugin({
      capabilities: {
        skills: [
          { pluginId: "acme", version: "1.0.0", root: "/b" },
          { pluginId: "acme", version: "1.0.0", root: "/a" },
        ],
        commandTools: [
          { name: "alpha", command: "node" },
          { name: "zeta", command: "node" },
        ],
      },
    });
    expect(computePermissionsHash(orderedAB)).toBe(computePermissionsHash(orderedBA));
  });

  test("changes when a command tool's command changes", () => {
    const before = computePermissionsHash(
      basePlugin({ capabilities: { skills: [], commandTools: [{ name: "echo", command: "node" }] } }),
    );
    const after = computePermissionsHash(
      basePlugin({ capabilities: { skills: [], commandTools: [{ name: "echo", command: "python" }] } }),
    );
    expect(before).not.toBe(after);
  });

  test("changes when a command tool's env value changes (#315)", () => {
    const staging = computePermissionsHash(basePlugin({
      capabilities: {
        skills: [],
        commandTools: [{ name: "echo", command: "node", env: { TARGET: "staging" } }],
      },
    }));
    const prod = computePermissionsHash(basePlugin({
      capabilities: {
        skills: [],
        commandTools: [{ name: "echo", command: "node", env: { TARGET: "prod.example.internal" } }],
      },
    }));
    expect(staging).not.toBe(prod);
  });

  test("changes when a command tool's metadata changes (#315)", () => {
    const readOnly = computePermissionsHash(basePlugin({
      capabilities: {
        skills: [],
        commandTools: [{ name: "echo", command: "node", metadata: { isReadOnly: true } }],
      },
    }));
    const mutable = computePermissionsHash(basePlugin({
      capabilities: {
        skills: [],
        commandTools: [{ name: "echo", command: "node", metadata: { isReadOnly: false } }],
      },
    }));
    expect(readOnly).not.toBe(mutable);
  });

  test("is order-independent for env keys of a command tool (#315)", () => {
    const ab = basePlugin({
      capabilities: {
        skills: [],
        commandTools: [{ name: "echo", command: "node", env: { A: "1", B: "2" } }],
      },
    });
    const ba = basePlugin({
      capabilities: {
        skills: [],
        commandTools: [{ name: "echo", command: "node", env: { B: "2", A: "1" } }],
      },
    });
    expect(computePermissionsHash(ab)).toBe(computePermissionsHash(ba));
  });

  test("keeps command tool args order-sensitive: same elements in a different order change the hash (#315 review)", () => {
    const forward = basePlugin({
      capabilities: {
        skills: [],
        commandTools: [{ name: "copy", command: "cp", args: ["--in", "a.mp4", "--out", "b.gif"] }],
      },
    });
    const reversed = basePlugin({
      capabilities: {
        skills: [],
        commandTools: [{ name: "copy", command: "cp", args: ["--out", "b.gif", "--in", "a.mp4"] }],
      },
    });
    expect(computePermissionsHash(forward)).not.toBe(computePermissionsHash(reversed));
  });
});
