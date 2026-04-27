import { describe, expect, test } from "bun:test";
import {
  isWorkspaceDocEffectivelyEmpty,
  sanitizeWorkspacePromptComponent
} from "./workspace-doc-sanitizer";

describe("workspace-doc-sanitizer", () => {
  test("filters empty USER.md template content", () => {
    const content = `---
title: "USER.md Template"
---

# USER.md - About Your Human

_Learn about the person you're helping. Update this as you go._

- **Name:**
- **What to call them:**
- **Pronouns:** _(optional)_
- **Timezone:**
- **Notes:**

## Context

_(What do they care about? What projects are they working on?)_
`;

    expect(isWorkspaceDocEffectivelyEmpty("USER", content)).toBeTrue();
    expect(sanitizeWorkspacePromptComponent("USER", content)).toBe("");
  });

  test("filters empty IDENTITY.md template content", () => {
    const content = `# IDENTITY.md - Who Am I?

- **Name:**
- **Creature / Nature:**
- **Vibe:**
- **Emoji:**
- **Avatar:**

## Voice

- **Default tone:**
- **How direct are you:**
- **How playful are you:**
`;

    expect(isWorkspaceDocEffectivelyEmpty("IDENTITY", content)).toBeTrue();
    expect(sanitizeWorkspacePromptComponent("IDENTITY", content)).toBe("");
  });

  test("keeps USER.md once it contains durable user information", () => {
    const content = `# USER.md

## Stable Preferences

- Prefers direct, concrete implementation plans over abstract advice.
- Likes shadcn/ui and Tailwind for interface work.
`;

    expect(isWorkspaceDocEffectivelyEmpty("USER", content)).toBeFalse();
    expect(sanitizeWorkspacePromptComponent("USER", content)).toContain("Prefers direct");
  });

  test("keeps default AGENTS and SOUL context", () => {
    expect(isWorkspaceDocEffectivelyEmpty("AGENTS", "# AGENTS.md\n\nRead SOUL.md before work.")).toBeFalse();
    expect(isWorkspaceDocEffectivelyEmpty("SOUL", "# SOUL.md\n\nBe useful and natural.")).toBeFalse();
  });
});
