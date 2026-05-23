import { describe, expect, test } from "bun:test";
import {
  BUILTIN_AGENT_ROLES,
  canAgentRolesRunInParallel,
  getAgentRole,
  suggestAgentRoles
} from "./agent-roles";

describe("agent roles registry", () => {
  test("exposes Alice-inspired built-in roles in stable order", () => {
    expect(BUILTIN_AGENT_ROLES.map((role) => role.id)).toEqual([
      "researcher",
      "translator",
      "writer",
      "voice",
      "designer",
      "artist",
      "analyst",
      "quant",
      "novelist",
      "docsmith",
      "developer"
    ]);

    expect(new Set(BUILTIN_AGENT_ROLES.map((role) => role.id)).size).toBe(BUILTIN_AGENT_ROLES.length);
    expect(getAgentRole("designer")?.displayName).toBe("林澄");
    expect(getAgentRole("developer")?.defaultSkillName).toBe("agent-developer");
  });

  test("suggests roles by keyword score with matched keywords", () => {
    expect(suggestAgentRoles("帮我调研竞品资料并核查信息").map((item) => ({
      roleId: item.roleId,
      score: item.score,
      matchedKeywords: item.matchedKeywords
    }))).toEqual([{
      roleId: "researcher",
      score: 5,
      matchedKeywords: ["调研", "核查", "信息", "资料", "竞品"]
    }]);

    expect(suggestAgentRoles("做一个 PPT dashboard 数据可视化页面").map((item) => item.roleId).slice(0, 3)).toEqual([
      "designer",
      "analyst",
      "docsmith"
    ]);
  });

  test("checks parallel safety with wildcard and explicit conflicts", () => {
    expect(canAgentRolesRunInParallel("researcher", "developer")).toBe(true);
    expect(canAgentRolesRunInParallel("writer", "designer")).toBe(true);
    expect(canAgentRolesRunInParallel("writer", "developer")).toBe(false);
    expect(canAgentRolesRunInParallel("writer", "docsmith")).toBe(false);
  });
});
