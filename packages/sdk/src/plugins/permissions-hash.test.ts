import { describe, expect, test } from "bun:test";
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
});
