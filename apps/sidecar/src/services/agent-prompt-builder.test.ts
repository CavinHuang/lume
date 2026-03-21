import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSystemPromptAppend,
  LUME_AGENT_IDENTITY_LINE,
  resolveSystemPromptMode,
  shouldLoadLongTermMemory
} from "./agent-prompt-builder";
import { getAgentWorkspacePath } from "./config-paths";

describe("agent-prompt-builder", () => {
  let prevConfigDir: string | undefined;
  let tempConfigDir = "";

  beforeEach(() => {
    prevConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-prompt-builder-test-"));
    process.env.LUME_CONFIG_DIR = tempConfigDir;
  });

  afterEach(() => {
    if (prevConfigDir === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = prevConfigDir;
    }
    if (tempConfigDir) {
      rmSync(tempConfigDir, { recursive: true, force: true });
      tempConfigDir = "";
    }
  });

  test("buildSystemPromptAppend 在工作区上下文中应包含记忆工具强制规则", () => {
    const prompt = buildSystemPromptAppend({
      sessionId: "session-1",
      availableTools: ["memory_search", "memory_get"],
      memoryCitationsMode: "auto"
    });
    expect(prompt).toContain("## Memory Recall");
    expect(prompt).toContain("memory_search");
    expect(prompt).toContain("memory_get");
    expect(prompt).toContain("Do not use generic read for memory files");
    expect(prompt).toContain("Citations:");
  });

  test("buildSystemPromptAppend 在 citations=off 时应输出关闭提示", () => {
    const prompt = buildSystemPromptAppend({
      sessionId: "session-1",
      availableTools: ["memory_search", "memory_get"],
      memoryCitationsMode: "off"
    });
    expect(prompt).toContain("Citations are disabled");
  });

  test("同时具备 browser 与 web_search 时应注入 Browser-First 策略", () => {
    const prompt = buildSystemPromptAppend({
      sessionId: "session-browser-first",
      availableTools: ["browser", "web_search"]
    });
    expect(prompt).toContain("## Browser-First Tool Policy (Mandatory)");
    expect(prompt).toContain("必须优先使用 browser 工具");
    expect(prompt).toContain("仅在以下情况才回退 web_search");
  });

  test("automationExecution=true 时应注入无交互模式约束", () => {
    const prompt = buildSystemPromptAppend({
      sessionId: "session-automation",
      availableTools: ["read", "write"],
      automationExecution: true
    });
    expect(prompt).toContain("## Automation Non-Interactive Mode");
    expect(prompt).toContain("禁止调用 AskUserQuestion");
    expect(prompt).toContain("E_AUTOMATION_INTERACTION_DISABLED");
  });

  test("buildSystemPromptAppend 应包含 session bootstrap 读取顺序", () => {
    const prompt = buildSystemPromptAppend({
      sessionId: "session-2",
      availableTools: []
    });
    expect(prompt).toContain("## Session Bootstrap (Mandatory)");
    expect(prompt).toContain("1. AGENTS.md");
    expect(prompt).toContain("2. SOUL.md");
    expect(prompt).toContain("6. memory/YYYY-MM-DD.md (today + yesterday)");
    expect(prompt).toContain("7. MEMORY.md (or memory.md fallback, main/direct session only)");
    expect(prompt).toContain("## Workspace Files (injected)");
    expect(prompt).toContain("## Safety");
    expect(prompt).toContain("## Runtime");
  });

  test("buildSystemPromptAppend 应始终以 agent 身份主句开头", () => {
    const prompt = buildSystemPromptAppend({
      sessionId: "session-identity",
      availableTools: []
    });
    const firstLine = prompt.split("\n")[0]?.trim();
    expect(firstLine).toBe(LUME_AGENT_IDENTITY_LINE);
  });

  test("buildSystemPromptAppend 在 promptMode=none 时仅保留身份主句", () => {
    const prompt = buildSystemPromptAppend({
      sessionId: "session-none",
      availableTools: ["memory_search", "memory_get"],
      promptMode: "none"
    });
    expect(prompt.trim()).toBe(LUME_AGENT_IDENTITY_LINE);
  });

  test("buildSystemPromptAppend 在 promptMode=minimal 时应保留 Tooling/Workspace/Runtime", () => {
    const prompt = buildSystemPromptAppend({
      sessionId: "session-minimal",
      workspaceSlug: "demo-workspace",
      availableTools: ["memory_search", "memory_get"],
      promptMode: "minimal"
    });
    expect(prompt).toContain(LUME_AGENT_IDENTITY_LINE);
    expect(prompt).toContain("## Tooling");
    expect(prompt).toContain("- memory_search");
    expect(prompt).toContain("## Workspace");
    expect(prompt).toContain("## Runtime");
    expect(prompt).not.toContain("## Session Bootstrap (Mandatory)");
    expect(prompt).not.toContain("## Memory Recall");
  });

  test("Tooling 段应按预设顺序输出并保留首次出现大小写", () => {
    const prompt = buildSystemPromptAppend({
      sessionId: "session-tool-order",
      promptMode: "minimal",
      availableTools: ["memory_get", "Write", "read", "AskUserQuestion", "memory_search", "write"]
    });
    const indexRead = prompt.indexOf("- read");
    const indexWrite = prompt.indexOf("- Write");
    const indexAskUserQuestion = prompt.indexOf("- AskUserQuestion");
    const indexMemorySearch = prompt.indexOf("- memory_search");
    const indexMemoryGet = prompt.indexOf("- memory_get");

    expect(indexRead).toBeGreaterThan(-1);
    expect(indexWrite).toBeGreaterThan(indexRead);
    expect(indexAskUserQuestion).toBeGreaterThan(indexWrite);
    expect(indexMemorySearch).toBeGreaterThan(indexAskUserQuestion);
    expect(indexMemoryGet).toBeGreaterThan(indexMemorySearch);
    expect(prompt.match(/- write/g)?.length ?? 0).toBe(0);
  });

  test("resolveSystemPromptMode 对 subagent 默认返回 minimal", () => {
    const mode = resolveSystemPromptMode({
      sessionId: "subagent:session-1"
    });
    expect(mode).toBe("minimal");
  });

  test("shouldLoadLongTermMemory 仅 direct 为 true", () => {
    expect(shouldLoadLongTermMemory("direct")).toBeTrue();
    expect(shouldLoadLongTermMemory("group")).toBeFalse();
    expect(shouldLoadLongTermMemory("channel")).toBeFalse();
  });

  test("仅存在 memory.md 时，Project Context 应显示 memory.md", () => {
    const workspaceSlug = `prompt-memory-alt-${Date.now()}`;
    const workspacePath = getAgentWorkspacePath(workspaceSlug);
    writeFileSync(join(workspacePath, "memory.md"), "# alt\nhello", "utf-8");

    const prompt = buildSystemPromptAppend({
      sessionId: "session-memory-alt",
      workspaceSlug,
      chatType: "direct",
      availableTools: ["memory_search"]
    });

    expect(prompt).toContain("## memory.md");
    expect(prompt).not.toContain("## MEMORY.md");
  });
});
