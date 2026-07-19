import { describe, expect, test } from "bun:test";
import { buildInvocableSkillCatalog, isPluginEnabledForComposer } from "./invocable-capability-catalog";

function candidate(name: string, priority: number, scope: "workspace" | "project" | "user", options: {
  descriptor?: boolean;
  label?: string;
} = {}) {
  return {
    root: { path: `/skills/${scope}/${priority}`, priority, scope },
    definition: {
      name,
      description: `${scope} ${name}`,
      aliases: options.label ? [options.label] : undefined,
      invocationDescriptor: options.descriptor === false ? undefined : {
        promptTemplate: "Do ${ARG}",
        argumentToken: "${ARG}",
        context: "inline",
        fingerprint: `${scope}-${priority}`,
      },
      getPrompt: async () => [],
    },
  };
}

describe("buildInvocableSkillCatalog", () => {
  test("selects the unique highest-priority definition", () => {
    const [item] = buildInvocableSkillCatalog([
      candidate("review", 20, "user"),
      candidate("review", 40, "workspace", { label: "Workspace Review" }),
    ] as any, { enabled: new Set(), disabled: new Set() });

    expect(item).toMatchObject({
      uri: "lume-skill://review",
      displayName: "Workspace Review",
      scope: "workspace",
      callable: true,
    });
  });

  test("fails closed for same-priority ambiguity", () => {
    const [item] = buildInvocableSkillCatalog([
      candidate("review", 30, "project"),
      candidate("review", 30, "project"),
    ] as any, { enabled: new Set(), disabled: new Set() });

    expect(item).toMatchObject({ callable: false, unavailableReason: "ambiguous" });
  });

  test("does not advertise callback-only legacy definitions as callable", () => {
    const [item] = buildInvocableSkillCatalog([
      candidate("legacy", 40, "workspace", { descriptor: false }),
    ] as any, { enabled: new Set(), disabled: new Set() });

    expect(item).toMatchObject({ callable: false, unavailableReason: "legacy-definition" });
  });
});

describe("isPluginEnabledForComposer", () => {
  test("keeps disabled and unselected plugins discoverable but not enabled", () => {
    expect(isPluginEnabledForComposer(
      { pluginId: "disabled-plugin" },
      { enabled: [], disabled: ["disabled-plugin"] },
    )).toBe(false);
    expect(isPluginEnabledForComposer(
      { pluginId: "not-selected" },
      { enabled: ["selected"], disabled: [] },
    )).toBe(false);
    expect(isPluginEnabledForComposer(
      { pluginId: "builtin", builtin: true },
      { enabled: [], disabled: ["builtin"] },
    )).toBe(true);
  });
});
