import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import {
  applyPiToolPolicies,
  getAgentRuntimeToolPolicyConfig,
  resolveEnabledPiMemoryToolNames,
  saveAgentRuntimeToolPolicyConfig
} from "./tool-policy";

describe("tool-policy", () => {
  test("subagent 默认策略应禁止 sessions 工具", () => {
    const previousConfigDir = process.env.LUME_CONFIG_DIR;
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-policy-test-"));
    try {
      const tools = [
        { name: "read" },
        { name: "sessions_list" },
        { name: "sessions_spawn" },
        { name: "web_fetch" }
      ] as unknown as AgentTool[];
      const filtered = applyPiToolPolicies(tools, {
        sessionType: "subagent"
      });
      expect(filtered.map((tool) => tool.name)).toEqual(["read", "web_fetch"]);
    } finally {
      if (previousConfigDir === undefined) {
        delete process.env.LUME_CONFIG_DIR;
      } else {
        process.env.LUME_CONFIG_DIR = previousConfigDir;
      }
    }
  });

  test("messageMetadata.toolPolicy 应在末层生效", () => {
    const previousConfigDir = process.env.LUME_CONFIG_DIR;
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-policy-test-"));
    try {
      const tools = [
        { name: "read" },
        { name: "write" },
        { name: "web_fetch" }
      ] as unknown as AgentTool[];
      const filtered = applyPiToolPolicies(tools, {
        sessionType: "main",
        messageMetadata: {
          toolPolicy: {
            allow: ["group:fs", "web_fetch"],
            deny: ["write"]
          }
        }
      });
      expect(filtered.map((tool) => tool.name)).toEqual(["read", "web_fetch"]);
    } finally {
      if (previousConfigDir === undefined) {
        delete process.env.LUME_CONFIG_DIR;
      } else {
        process.env.LUME_CONFIG_DIR = previousConfigDir;
      }
    }
  });

  test("应按 memory policy 返回启用工具", () => {
    const tools = resolveEnabledPiMemoryToolNames({
      allow: ["memory_search", "memory_get"],
      deny: ["memory_get"]
    });
    expect(tools).toEqual(["memory_search"]);
  });

  test("应支持读取和保存 runtime tool policy 配置", () => {
    const previousConfigDir = process.env.LUME_CONFIG_DIR;
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-policy-test-"));
    try {
      const defaultConfig = getAgentRuntimeToolPolicyConfig();
      expect(defaultConfig.version).toBe(1);

      const saved = saveAgentRuntimeToolPolicyConfig({
        version: 99,
        tools: {
          allow: ["group:fs"],
          byProvider: {
            anthropic: { allow: ["web_*"] }
          },
          bySessionType: {
            subagent: { deny: ["group:sessions"] }
          }
        }
      });
      expect(saved.version).toBe(99);
      expect(saved.tools?.allow).toEqual(["group:fs"]);
      expect(saved.tools?.byProvider?.anthropic?.allow).toEqual(["web_*"]);
      expect(saved.tools?.subagent?.deny).toEqual([
        "agents_list",
        "sessions_list",
        "sessions_history",
        "sessions_send",
        "sessions_delete",
        "sessions_spawn",
        "session_status",
        "subagents_list",
        "subagents_kill",
        "subagents_send",
        "subagents_steer"
      ]);
    } finally {
      if (previousConfigDir === undefined) {
        delete process.env.LUME_CONFIG_DIR;
      } else {
        process.env.LUME_CONFIG_DIR = previousConfigDir;
      }
    }
  });
});
