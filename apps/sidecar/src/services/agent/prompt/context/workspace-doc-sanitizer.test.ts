import { describe, expect, test } from "bun:test";
import { sanitizeWorkspaceDoc } from "./workspace-doc-sanitizer";

describe("workspace-doc-sanitizer", () => {
  test("filters effectively empty user templates", () => {
    const sanitized = sanitizeWorkspaceDoc("USER", [
      "---",
      "title: User",
      "---",
      "# USER.md",
      "",
      "- Name:",
      "- What to call them:",
      "- Pronouns:",
      "- Timezone:",
      "- Notes:"
    ].join("\n"));

    expect(sanitized).toBeNull();
  });

  test("keeps meaningful workspace content", () => {
    const sanitized = sanitizeWorkspaceDoc("WORKSPACE", [
      "# WORKSPACE.md",
      "",
      "## Purpose",
      "",
      "Prompt runtime experiments."
    ].join("\n"));

    expect(sanitized).toEqual({
      type: "WORKSPACE",
      content: "## Purpose\nPrompt runtime experiments."
    });
  });

  test("filters noisy default AGENTS template with heartbeat and group-chat policy", () => {
    const sanitized = sanitizeWorkspaceDoc("AGENTS", [
      "# AGENTS.md - Your Workspace",
      "This folder is home. Treat it that way.",
      "## First Run",
      "If `BOOTSTRAP.md` exists, follow its setup guidance once, establish a sensible default working style, then delete it.",
      "## Group Chats",
      "You have access to your human's stuff. That doesn't mean you _share_ their stuff.",
      "### 😊 React Like a Human!",
      "On platforms that support reactions (Discord, Slack), use emoji reactions naturally:",
      "## 💓 Heartbeats - Be Proactive!",
      "When you receive a heartbeat poll (message matches the configured heartbeat prompt), don't just reply `HEARTBEAT_OK` every time.",
      "## Make It Yours",
      "This is a starting point. Add your own conventions, style, and rules as you figure out what works."
    ].join("\n"));

    expect(sanitized).toBeNull();
  });

  test("filters noisy default TOOLS template", () => {
    const sanitized = sanitizeWorkspaceDoc("TOOLS", [
      "# TOOLS.md - Local Notes",
      "Skills define _how_ tools work. This file is for _your_ specifics — the stuff that's unique to your setup.",
      "## What Goes Here",
      "Things like:",
      "- Camera names and locations",
      "- SSH hosts and aliases",
      "## Why Separate?",
      "Skills are shared. Your setup is yours. Keeping them apart means you can update skills without losing your notes, and share skills without leaking your infrastructure.",
      "Add whatever helps you do your job. This is your cheat sheet."
    ].join("\n"));

    expect(sanitized).toBeNull();
  });

  test("filters blank default USER template even when explanatory prose exists", () => {
    const sanitized = sanitizeWorkspaceDoc("USER", [
      "# USER.md - About Your Human",
      "_Learn about the person you're helping. Update this as you go._",
      "- **Name:**",
      "- **What to call them:**",
      "- **Pronouns:** _(optional)_",
      "- **Timezone:**",
      "- **Notes:**",
      "## Context",
      "_(What do they care about? What projects are they working on? What annoys them? What makes them laugh? Build this over time.)_",
      "## Companion Preferences",
      "_(How human-like should you feel to them? How direct, playful, warm, or serious should you be? Are there any identity or tone boundaries they explicitly want?)_",
      "The more you know, the better you can help. But remember — you're learning about a person, not building a dossier. Respect the difference."
    ].join("\n"));

    expect(sanitized).toBeNull();
  });

  test("compacts soul content to a short persona contract", () => {
    const sanitized = sanitizeWorkspaceDoc("SOUL", [
      "# SOUL.md",
      "",
      "## Style",
      "- Natural and direct.",
      "- Useful before performative.",
      "",
      "## Long Notes",
      "Line 1",
      "Line 2",
      "Line 3",
      "Line 4",
      "Line 5",
      "Line 6",
      "Line 7",
      "Line 8",
      "Line 9",
      "Line 10",
      "Line 11",
      "Line 12",
      "Line 13"
    ].join("\n"));

    expect(sanitized?.content.split("\n")).toHaveLength(12);
    expect(sanitized?.content).toContain("- Natural and direct.");
    expect(sanitized?.content).not.toContain("Line 13");
  });
});
