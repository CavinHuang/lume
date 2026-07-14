import { describe, expect, test } from "bun:test";
import { filterComputerUseSkills, resolveComputerUseSurface } from "./computer-use-surface";

describe("resolveComputerUseSurface", () => {
  test("honors an explicitly configured surface", () => {
    expect(resolveComputerUseSurface({ agentSurface: "sky" })).toBe("sky");
    expect(resolveComputerUseSurface({ agentSurface: "mcp", channelProvider: "openai" })).toBe("mcp");
  });

  test("routes exact configured models and OpenAI channels to sky in auto mode", () => {
    expect(resolveComputerUseSurface({
      agentSurface: "auto",
      modelRef: "custom/codex-model",
      skyModelRefs: ["custom/codex-model"],
    })).toBe("sky");
    expect(resolveComputerUseSurface({
      modelRef: "openai/gpt-5",
      channelProvider: "openai",
    })).toBe("sky");
  });

  test("keeps other and unresolved models on the MCP surface", () => {
    expect(resolveComputerUseSurface({ modelRef: "anthropic/claude", channelProvider: "anthropic" })).toBe("mcp");
    expect(resolveComputerUseSurface({})).toBe("mcp");
  });

  test("exposes the bundled skill only on the sky surface", () => {
    const skills = [{ name: "computer-use:computer-use" }, { name: "other:skill" }];

    expect(filterComputerUseSkills(skills, "sky")).toEqual(skills);
    expect(filterComputerUseSkills(skills, "mcp")).toEqual([{ name: "other:skill" }]);
  });
});
