import { describe, expect, test } from "bun:test";
import type { LumeToolDescriptor, LumeToolMetadata } from "../tools/tool-types";
import { createPermissionSessionStore } from "./permission-session";
import { PermissionEngine } from "./permission-engine";

function descriptor(
  name: string,
  metadata: Partial<LumeToolMetadata>
): LumeToolDescriptor {
  return {
    name,
    canonicalName: name.toLowerCase(),
    source: "sdk",
    definition: { name } as any,
    metadata: {
      category: "control",
      capability: "skill",
      riskLevel: "medium",
      sideEffects: "none",
      allowedInPlanMode: false,
      isReadOnly: false,
      isConcurrencySafe: false,
      requiresApprovalByDefault: true,
      ...metadata
    }
  };
}

const read = descriptor("Read", {
  category: "read",
  capability: "filesystem",
  riskLevel: "low",
  sideEffects: "local_read",
  allowedInPlanMode: true,
  isReadOnly: true,
  isConcurrencySafe: true,
  requiresApprovalByDefault: false
});

const write = descriptor("Write", {
  category: "write",
  capability: "filesystem",
  riskLevel: "medium",
  sideEffects: "local_write"
});

const bash = descriptor("Bash", {
  category: "execute",
  capability: "shell",
  riskLevel: "high",
  sideEffects: "process"
});

describe("PermissionEngine", () => {
  test("plan mode denies unsafe tools and allows descriptor plan-safe tools", async () => {
    const engine = new PermissionEngine();

    await expect(engine.decide({
      descriptor: write,
      input: { file_path: "note.txt" },
      mode: "plan",
      context: { threadId: "thread-1", cwd: "/tmp/project" }
    })).resolves.toMatchObject({
      status: "deny",
      reasonCode: "mode_plan",
      riskLevel: "medium"
    });

    await expect(engine.decide({
      descriptor: read,
      input: { file_path: "note.txt" },
      mode: "plan",
      context: { threadId: "thread-1", cwd: "/tmp/project" }
    })).resolves.toMatchObject({
      status: "allow",
      reasonCode: "mode_plan"
    });
  });

  test("acceptEdits allows filesystem edits but still asks for shell execution", async () => {
    const engine = new PermissionEngine();

    await expect(engine.decide({
      descriptor: write,
      input: { file_path: "note.txt" },
      mode: "acceptEdits",
      context: { threadId: "thread-1", cwd: "/tmp/project" }
    })).resolves.toMatchObject({
      status: "allow",
      reasonCode: "mode_accept_edits"
    });

    await expect(engine.decide({
      descriptor: bash,
      input: { command: "echo hi" },
      mode: "acceptEdits",
      context: { threadId: "thread-1", cwd: "/tmp/project" }
    })).resolves.toMatchObject({
      status: "approval_required",
      reasonCode: "risk_requires_approval"
    });
  });

  test("dontAsk allows low-risk commands but still asks for dangerous commands", async () => {
    const engine = new PermissionEngine();

    await expect(engine.decide({
      descriptor: bash,
      input: { command: "pwd" },
      mode: "dontAsk",
      context: { threadId: "thread-1", cwd: "/tmp/project" }
    })).resolves.toMatchObject({
      status: "allow",
      reasonCode: "mode_dont_ask_safe"
    });

    await expect(engine.decide({
      descriptor: bash,
      input: { command: "rm -rf /" },
      mode: "dontAsk",
      context: { threadId: "thread-1", cwd: "/tmp/project" }
    })).resolves.toMatchObject({
      status: "approval_required",
      reasonCode: "risk_requires_approval",
      riskLevel: "critical"
    });
  });

  test("classifier can be disabled so metadata remains the approval source", async () => {
    let classifierCalls = 0;
    const engine = new PermissionEngine({
      classifier: {
        async classify() {
          classifierCalls += 1;
          return {
            riskLevel: "low",
            reasonCode: "test_classifier",
            explanation: "测试分类器允许",
            shouldAsk: false
          };
        }
      }
    });

    await expect(engine.decide({
      descriptor: bash,
      input: { command: "pwd" },
      mode: "dontAsk",
      classifierEnabled: false,
      context: { threadId: "thread-1", cwd: "/tmp/project" }
    })).resolves.toMatchObject({
      status: "approval_required",
      reasonCode: "metadata_requires_approval",
      riskLevel: "high"
    });
    expect(classifierCalls).toBe(0);
  });

  test("bypassPermissions allows approval checks without suppressing structured reason", async () => {
    const engine = new PermissionEngine();

    await expect(engine.decide({
      descriptor: bash,
      input: { command: "rm -rf /" },
      mode: "bypassPermissions",
      context: { threadId: "thread-1", cwd: "/tmp/project" }
    })).resolves.toMatchObject({
      status: "allow",
      reasonCode: "mode_bypass"
    });
  });

  test("session grants are scoped by tool and normalized input fingerprint", async () => {
    const session = createPermissionSessionStore();
    const engine = new PermissionEngine({ session });
    session.grant({
      threadId: "thread-1",
      descriptor: bash,
      input: { command: "ls" }
    });

    await expect(engine.decide({
      descriptor: bash,
      input: { command: "ls" },
      mode: "default",
      context: { threadId: "thread-1", cwd: "/tmp/project" }
    })).resolves.toMatchObject({
      status: "allow",
      reasonCode: "session_allow"
    });

    await expect(engine.decide({
      descriptor: bash,
      input: { command: "rm -rf /tmp/nope" },
      mode: "default",
      context: { threadId: "thread-1", cwd: "/tmp/project" }
    })).resolves.toMatchObject({
      status: "approval_required"
    });
  });

  test("session bypass allows later approvals in the same thread", async () => {
    const session = createPermissionSessionStore();
    const engine = new PermissionEngine({ session });
    session.bypass("thread-1");

    await expect(engine.decide({
      descriptor: bash,
      input: { command: "rm -rf /tmp/nope" },
      mode: "default",
      context: { threadId: "thread-1", cwd: "/tmp/project" }
    })).resolves.toMatchObject({
      status: "allow",
      reasonCode: "session_bypass"
    });
  });

  test("permission rules use first matching action", async () => {
    const engine = new PermissionEngine({
      rules: [
        { id: "deny-rm", scope: "workspace", tool: "Bash", commandPattern: "rm\\s+-rf", action: "deny" },
        { id: "allow-bash", scope: "workspace", tool: "Bash", action: "allow" }
      ]
    });

    await expect(engine.decide({
      descriptor: bash,
      input: { command: "rm -rf ./build" },
      mode: "default",
      context: { threadId: "thread-1", cwd: "/tmp/project" }
    })).resolves.toMatchObject({
      status: "deny",
      reasonCode: "rule_deny",
      matchedRuleId: "deny-rm"
    });
  });

  test("permission rules share Tool Runtime group and wildcard matching", async () => {
    const engine = new PermissionEngine({
      rules: [
        { id: "deny-fs", scope: "workspace", tool: "group:fs", action: "deny" },
        { id: "allow-web", scope: "workspace", tool: "web_*", action: "allow" }
      ]
    });
    const webSearch = descriptor("web_search", {
      category: "network",
      capability: "web",
      riskLevel: "medium",
      sideEffects: "network"
    });

    await expect(engine.decide({
      descriptor: write,
      input: { file_path: "note.txt" },
      mode: "default",
      context: { threadId: "thread-1", cwd: "/tmp/project" }
    })).resolves.toMatchObject({
      status: "deny",
      matchedRuleId: "deny-fs"
    });

    await expect(engine.decide({
      descriptor: webSearch,
      input: { query: "lume" },
      mode: "default",
      context: { threadId: "thread-1", cwd: "/tmp/project" }
    })).resolves.toMatchObject({
      status: "allow",
      matchedRuleId: "allow-web"
    });
  });

  test("private write roots are allowed without allowing user project writes", async () => {
    const engine = new PermissionEngine();

    await expect(engine.decide({
      descriptor: write,
      input: { file_path: "/tmp/project/.lume/plugins/demo/plugin.json" },
      mode: "default",
      context: {
        threadId: "thread-1",
        cwd: "/tmp/project",
        privateWriteRoots: ["/tmp/project/.lume"]
      }
    })).resolves.toMatchObject({
      status: "allow",
      reasonCode: "private_root"
    });

    await expect(engine.decide({
      descriptor: write,
      input: { file_path: "/tmp/project/src/app.ts" },
      mode: "default",
      context: {
        threadId: "thread-1",
        cwd: "/tmp/project",
        privateWriteRoots: ["/tmp/project/.lume"]
      }
    })).resolves.toMatchObject({
      status: "approval_required"
    });
  });

  test("explicit deny rules override private write root auto allow", async () => {
    const engine = new PermissionEngine();
    const write = descriptor("Write", {
      category: "write",
      capability: "filesystem",
      riskLevel: "medium",
      sideEffects: "local_write",
      allowedInPlanMode: false,
      isReadOnly: false,
      isConcurrencySafe: false
    });

    await expect(engine.decide({
      descriptor: write,
      input: { file_path: ".lume/blocked.json" },
      mode: "default",
      context: { threadId: "thread-1", cwd: "/tmp/project", privateWriteRoots: ["/tmp/project/.lume"] },
      rules: [{ id: "deny-private", scope: "workspace", tool: "Write", pathPattern: ".lume/**", action: "deny" }]
    })).resolves.toMatchObject({
      status: "deny",
      reasonCode: "rule_deny",
      matchedRuleId: "deny-private"
    });
  });
});
