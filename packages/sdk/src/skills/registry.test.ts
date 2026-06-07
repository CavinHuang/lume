import { afterEach, expect, test } from "bun:test";
import { clearSkills, formatSkillsForPrompt, getSkill, hasSkill, registerSkill } from "./registry";

afterEach(() => {
  clearSkills();
});

test("getSkill accepts workspace-prefixed skill names", () => {
  registerSkill({
    name: "planner",
    description: "Plan work",
    getPrompt: async () => [{ type: "text", text: "plan" }]
  });

  expect(getSkill("lume-workspace-demo:planner")?.name).toBe("planner");
  expect(hasSkill("lume-workspace-demo:planner")).toBe(true);
});

test("getSkill matches names and aliases case-insensitively", () => {
  registerSkill({
    name: "code-review",
    aliases: ["CR"],
    description: "Review code",
    getPrompt: async () => [{ type: "text", text: "review" }]
  });

  expect(getSkill("CODE-REVIEW")?.name).toBe("code-review");
  expect(getSkill("cr")?.name).toBe("code-review");
  expect(getSkill("lume-workspace-demo:CODE-REVIEW")?.name).toBe("code-review");
});

test("registerSkill removes stale aliases when replacing the same skill", () => {
  registerSkill({
    name: "planner",
    aliases: ["old-plan"],
    description: "Old planner",
    getPrompt: async () => [{ type: "text", text: "old" }]
  });
  registerSkill({
    name: "planner",
    aliases: ["new-plan"],
    description: "New planner",
    getPrompt: async () => [{ type: "text", text: "new" }]
  });

  expect(getSkill("new-plan")?.description).toBe("New planner");
  expect(getSkill("old-plan")).toBeUndefined();
});

test("registerSkill replaces existing skills that differ only by case", () => {
  registerSkill({
    name: "Planner",
    aliases: ["old-planner"],
    description: "Old planner",
    getPrompt: async () => [{ type: "text", text: "old" }]
  });
  registerSkill({
    name: "planner",
    aliases: ["new-planner"],
    description: "New planner",
    getPrompt: async () => [{ type: "text", text: "new" }]
  });

  const prompt = formatSkillsForPrompt();

  expect(getSkill("PLANNER")?.description).toBe("New planner");
  expect(getSkill("old-planner")).toBeUndefined();
  expect(prompt).toContain("- planner: New planner");
  expect(prompt).not.toContain("- Planner: Old planner");
});

test("formatSkillsForPrompt exposes argument hints but not trigger details for model-invocable skills", () => {
  registerSkill({
    name: "code-review",
    description: "Review code",
    whenToUse: "when the user asks for code review",
    argumentHint: "path to review",
    getPrompt: async () => [{ type: "text", text: "review" }]
  });
  registerSkill({
    name: "manual-secret",
    description: "Manual secret",
    disableModelInvocation: true,
    argumentHint: "secret args",
    getPrompt: async () => [{ type: "text", text: "secret" }]
  });

  const prompt = formatSkillsForPrompt();

  expect(prompt).toContain("code-review");
  expect(prompt).not.toContain("when the user asks for code review");
  expect(prompt).not.toContain("TRIGGER");
  expect(prompt).toContain("path to review");
  expect(prompt).not.toContain("manual-secret");
  expect(prompt).not.toContain("secret args");
});
