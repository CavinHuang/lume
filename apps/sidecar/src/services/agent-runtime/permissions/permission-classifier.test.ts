import { describe, expect, test } from "bun:test";
import { createPermissionClassifier } from "./permission-classifier";

describe("permission classifier", () => {
  test("classifies critical shell patterns", async () => {
    const classifier = createPermissionClassifier();

    await expect(classifier.classify({
      toolName: "Bash",
      command: "git push origin main --force"
    })).resolves.toMatchObject({
      riskLevel: "critical",
      shouldAsk: true
    });
  });

  test("classifies medium shell write patterns", async () => {
    const classifier = createPermissionClassifier();

    await expect(classifier.classify({
      toolName: "Bash",
      command: "mkdir output"
    })).resolves.toMatchObject({
      riskLevel: "medium",
      shouldAsk: true,
      reasonCode: "shell_write_pattern"
    });
  });

  test("classifies sensitive file writes", async () => {
    const classifier = createPermissionClassifier();

    await expect(classifier.classify({
      toolName: "Write",
      path: "/tmp/project/.env"
    })).resolves.toMatchObject({
      riskLevel: "high",
      shouldAsk: true,
      reasonCode: "sensitive_path"
    });
  });

  test("classifies unknown plugin tools as external approval risk", async () => {
    const classifier = createPermissionClassifier();

    await expect(classifier.classify({
      toolName: "PluginEcho",
      source: "plugin"
    })).resolves.toMatchObject({
      riskLevel: "medium",
      shouldAsk: true,
      reasonCode: "external_tool"
    });
  });

  test("uses llm classifier cache for low-risk uncertain commands", async () => {
    let calls = 0;
    const classifier = createPermissionClassifier({
      llm: async () => {
        calls++;
        return JSON.stringify({
          riskLevel: "medium",
          reason: "writes generated files",
          shouldAsk: true
        });
      }
    });

    await classifier.classify({ toolName: "Bash", command: "node scripts/build.js" });
    await classifier.classify({ toolName: "Bash", command: "node scripts/build.js" });

    expect(calls).toBe(1);
  });

  test("falls back to heuristic result when llm classifier times out", async () => {
    const classifier = createPermissionClassifier({
      timeoutMs: 1,
      llm: () => new Promise((resolve) => setTimeout(() => resolve(JSON.stringify({
        riskLevel: "critical",
        reason: "late",
        shouldAsk: true
      })), 20))
    });

    await expect(classifier.classify({
      toolName: "Bash",
      command: "pwd"
    })).resolves.toMatchObject({
      riskLevel: "low",
      shouldAsk: false,
      reasonCode: "shell_read"
    });
  });
});
