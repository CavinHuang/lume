import { describe, expect, test } from "bun:test";
import {
  inspectMarketSourceInputSchema,
  installMarketItemInputSchema,
  setPluginEnablementInputSchema,
  updatePluginInputSchema
} from "./schemas";

describe("Plugin market RPC schemas", () => {
  test("inspectMarketSourceInputSchema accepts local, github, and market item sources", () => {
    expect(
      inspectMarketSourceInputSchema.parse({
        workspaceSlug: "default",
        source: { type: "local", path: "/tmp/plugin" }
      }).source.type
    ).toBe("local");

    expect(
      inspectMarketSourceInputSchema.parse({
        workspaceSlug: "default",
        source: { type: "github", owner: "acme", repo: "plugin", ref: "main", url: "https://github.com/acme/plugin" }
      }).source.type
    ).toBe("github");

    expect(
      inspectMarketSourceInputSchema.parse({
        workspaceSlug: "default",
        source: { type: "market-item", sourceId: "official", itemId: "plugin:demo" }
      }).source.type
    ).toBe("market-item");
  });

  test("installMarketItemInputSchema accepts plugin review hash and enable scope", () => {
    const parsed = installMarketItemInputSchema.parse({
      workspaceSlug: "default",
      kind: "plugin",
      source: { type: "local", path: "/tmp/plugin" },
      acceptedPermissionsHash: "abc123",
      enableScope: "workspace"
    });

    expect(parsed.kind).toBe("plugin");
    expect(parsed.acceptedPermissionsHash).toBe("abc123");
    expect(parsed.enableScope).toBe("workspace");
  });

  test("setPluginEnablementInputSchema requires workspaceSlug for workspace scope", () => {
    expect(() =>
      setPluginEnablementInputSchema.parse({
        pluginId: "demo",
        scope: "workspace",
        enabled: true
      })
    ).toThrow();

    expect(
      setPluginEnablementInputSchema.parse({
        workspaceSlug: "default",
        pluginId: "demo",
        scope: "workspace",
        enabled: true
      }).workspaceSlug
    ).toBe("default");
  });

  test("updatePluginInputSchema requires workspace slug", () => {
    expect(() =>
      updatePluginInputSchema.parse({
        pluginId: "demo"
      })
    ).toThrow();

    expect(
      updatePluginInputSchema.parse({
        workspaceSlug: "default",
        pluginId: "demo",
        acceptedPermissionsHash: "abc123"
      }).workspaceSlug
    ).toBe("default");
  });
});
