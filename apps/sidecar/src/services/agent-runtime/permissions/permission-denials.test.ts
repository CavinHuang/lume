import { describe, expect, test } from "bun:test";
import type { ToolDefinition } from "@lume/agent-sdk";
import { clearPermissionDenials, getPermissionDeniedSummary, recordPermissionDenial } from "./permission-denials";
import type { LumeToolDescriptor } from "../tools/tool-types";

function descriptor(name: string): LumeToolDescriptor {
  return {
    name,
    canonicalName: name.toLowerCase(),
    source: "sdk",
    definition: { name, description: name, inputSchema: { type: "object", properties: {} }, async call() { return { type: "tool_result", tool_use_id: "", content: "" }; } } as ToolDefinition,
    metadata: {
      category: "execute",
      capability: "shell",
      riskLevel: "high",
      sideEffects: "process",
      allowedInPlanMode: false,
      isReadOnly: false,
      isConcurrencySafe: false
    }
  };
}

describe("permission denials", () => {
  test("includes a concise command or path summary for model feedback", () => {
    const threadId = `thread-${crypto.randomUUID()}`;
    clearPermissionDenials(threadId);

    recordPermissionDenial({
      threadId,
      descriptor: descriptor("Bash"),
      rawInput: { command: "rm -rf /tmp/demo" },
      reasonCode: "user_denied"
    });

    expect(getPermissionDeniedSummary(threadId)).toContain("- Bash: user_denied (rm -rf /tmp/demo)");
  });
});

