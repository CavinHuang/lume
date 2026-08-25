import { describe, expect, test } from "bun:test";
import { isNativeAvailable } from "@lume/natives";
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

  test("acceptEdits allows filesystem edits and provably read-only shell, still asks mutating shell", async () => {
    // 注入缝驱动：分支位次语义与平台/natives 可用性无关
    const engine = new PermissionEngine({ isShellInputReadOnly: (input) => (input as { command?: string })?.command === "echo hi" });

    await expect(engine.decide({
      descriptor: write,
      input: { file_path: "note.txt" },
      mode: "acceptEdits",
      context: { threadId: "thread-1", cwd: "/tmp/project" }
    })).resolves.toMatchObject({
      status: "allow",
      reasonCode: "mode_accept_edits"
    });

    // 只读证明命令在 acceptEdits 下同样免审（#571 免审通道）
    await expect(engine.decide({
      descriptor: bash,
      input: { command: "echo hi" },
      mode: "acceptEdits",
      context: { threadId: "thread-1", cwd: "/tmp/project" }
    })).resolves.toMatchObject({
      status: "allow",
      reasonCode: "readonly_shell"
    });

    await expect(engine.decide({
      descriptor: bash,
      input: { command: "rm -rf ./build" },
      mode: "acceptEdits",
      context: { threadId: "thread-1", cwd: "/tmp/project" }
    })).resolves.toMatchObject({
      status: "approval_required"
    });
  });

  test("default mode auto-allows provably read-only shell commands (#571 免审通道)", async () => {
    const engine = new PermissionEngine({ isShellInputReadOnly: () => true });

    await expect(engine.decide({
      descriptor: bash,
      input: { command: "cat README.md" },
      mode: "default",
      context: { threadId: "thread-1", cwd: "/tmp/project" }
    })).resolves.toMatchObject({
      status: "allow",
      reasonCode: "readonly_shell",
      riskLevel: "low"
    });

    // 非 bash 工具不受该通道影响
    await expect(engine.decide({
      descriptor: write,
      input: { file_path: "note.txt" },
      mode: "default",
      context: { threadId: "thread-1", cwd: "/tmp/project" }
    })).resolves.toMatchObject({
      status: "approval_required"
    });
  });

  test.skipIf(!isNativeAvailable())("readonly wiring uses the real SDK static analysis end to end", async () => {
    // 真实判定链依赖 natives 语法树；CI 无 natives 构建时由注入缝用例覆盖分支逻辑，
    // 本用例只在产物在场时钉住端到端接线（双态口径，同 guardrails 测试）
    const engine = new PermissionEngine();

    await expect(engine.decide({
      descriptor: bash,
      input: { command: "cat README.md" },
      mode: "default",
      context: { threadId: "thread-1", cwd: "/tmp/project" }
    })).resolves.toMatchObject({
      status: "allow",
      reasonCode: "readonly_shell"
    });

    // 显式 PS 前缀的保守只读子集（纯正则，不依赖语法树）同样命中
    await expect(engine.decide({
      descriptor: bash,
      input: { command: "powershell -Command Get-Process" },
      mode: "default",
      context: { threadId: "thread-1", cwd: "/tmp/project" }
    })).resolves.toMatchObject({
      status: "allow",
      reasonCode: "readonly_shell"
    });
  });

  test("readonly channel is driven by injected proof seam and respects explicit ask rules", async () => {
    const allowAll = new PermissionEngine({ isShellInputReadOnly: () => true });
    await expect(allowAll.decide({
      descriptor: bash,
      input: { command: "anything-nonstandard" },
      mode: "default",
      context: { threadId: "thread-1", cwd: "/tmp/project" }
    })).resolves.toMatchObject({
      status: "allow",
      reasonCode: "readonly_shell"
    });

    // 用户显式 ask 的意图优先于内容证明
    const engine = new PermissionEngine({
      rules: [{ id: "ask-cat", scope: "workspace", tool: "Bash", commandPattern: "^cat\\b", action: "ask" }]
    });
    await expect(engine.decide({
      descriptor: bash,
      input: { command: "cat secrets.md" },
      mode: "default",
      context: { threadId: "thread-1", cwd: "/tmp/project" }
    })).resolves.toMatchObject({
      status: "approval_required",
      reasonCode: "rule_ask",
      matchedRuleId: "ask-cat"
    });
  });

  test("dontAsk allows classifier-judged low-risk commands but still asks for dangerous commands", async () => {
    const engine = new PermissionEngine({
      // 关闭只读通道以钉死分类器路径本身（pwd 现已被内容证明提前放行）
      isShellInputReadOnly: () => false
    });

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
      isShellInputReadOnly: () => false,
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
      input: { command: "node script.js" },
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

  test.skipIf(!isNativeAvailable())("content proof bypasses the classifier switch gate", async () => {
    // 可证只读的命令即使关闭分类器也免审（#571）；真实判定链依赖 natives，双态口径
    const proofEngine = new PermissionEngine();
    await expect(proofEngine.decide({
      descriptor: bash,
      input: { command: "git status" },
      mode: "dontAsk",
      classifierEnabled: false,
      context: { threadId: "thread-1", cwd: "/tmp/project" }
    })).resolves.toMatchObject({
      status: "allow",
      reasonCode: "readonly_shell"
    });
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

  test("Bash allow rules match every parsed subcommand and not unparseable shell", async () => {
    const engine = new PermissionEngine({
      rules: [{ id: "allow-rg", scope: "workspace", tool: "Bash", commandPattern: "^rg\\b", action: "allow" }]
    });

    await expect(engine.decide({
      descriptor: bash,
      input: { command: "rg prompt src && git push origin main" },
      mode: "default",
      context: { threadId: "thread-1", cwd: "/tmp/project" }
    })).resolves.toMatchObject({ status: "approval_required" });

    await expect(engine.decide({
      descriptor: bash,
      input: { command: "echo $(rg prompt src)" },
      mode: "default",
      classifierEnabled: false,
      context: { threadId: "thread-1", cwd: "/tmp/project" }
    })).resolves.toMatchObject({ status: "approval_required" });
  });

  test("PS 方言命令无法被语法树解析，但保守只读子集内允许精确指纹豁免（#571 第 3 项连带）", async () => {
    const engine = new PermissionEngine({
      rules: [{ id: "allow-ps-get", scope: "workspace", tool: "Bash", commandPattern: "^powershell -Command Get-Process$", action: "allow" }]
    });

    // 显式前缀 + 白名单动词：候选集放行，精确指纹命中
    await expect(engine.decide({
      descriptor: bash,
      input: { command: "powershell -Command Get-Process" },
      mode: "default",
      classifierEnabled: false,
      context: { threadId: "thread-1", cwd: "/tmp/project" }
    })).resolves.toMatchObject({
      status: "allow",
      reasonCode: "rule_allow",
      matchedRuleId: "allow-ps-get"
    });

    // 非白名单形态仍不得获得持久豁免
    await expect(engine.decide({
      descriptor: bash,
      input: { command: "powershell -Command Stop-Process -Name node" },
      mode: "default",
      classifierEnabled: false,
      context: { threadId: "thread-1", cwd: "/tmp/project" }
    })).resolves.toMatchObject({ status: "approval_required" });
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
