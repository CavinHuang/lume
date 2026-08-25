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

  test("classifies dependency commands and manifests as approval-required", async () => {
    const classifier = createPermissionClassifier();

    await expect(classifier.classify({ toolName: "Bash", command: "pnpm install" })).resolves.toMatchObject({
      riskLevel: "medium",
      shouldAsk: true
    });
    await expect(classifier.classify({ toolName: "Write", path: "package.json" })).resolves.toMatchObject({
      riskLevel: "medium",
      shouldAsk: true,
      reasonCode: "dependency_manifest"
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

  test("classifies PowerShell destructive verbs above low risk", async () => {
    const classifier = createPermissionClassifier();

    // 复核实证：这些命令曾被 POSIX 词表漏判为 low，dontAsk 下会自动放行递归删除
    await expect(classifier.classify({
      toolName: "Bash",
      command: "Remove-Item -Recurse -Force ~/important",
      shellKind: "powershell"
    })).resolves.toMatchObject({
      riskLevel: "medium",
      shouldAsk: true,
      reasonCode: "shell_write_pattern"
    });
    await expect(classifier.classify({ toolName: "Bash", command: "rd /s /q build", shellKind: "powershell" })).resolves.toMatchObject({
      riskLevel: "medium",
      shouldAsk: true
    });
    await expect(classifier.classify({ toolName: "Bash", command: "Stop-Service spooler", shellKind: "powershell" })).resolves.toMatchObject({
      riskLevel: "medium",
      shouldAsk: true
    });
    await expect(classifier.classify({ toolName: "Bash", command: "Set-ExecutionPolicy RemoteSigned", shellKind: "powershell" })).resolves.toMatchObject({
      riskLevel: "medium",
      shouldAsk: true
    });
    // format-* 曾只进 guardrail 层（跨层漂移实例），共享词表后分类器同档兜底
    await expect(classifier.classify({ toolName: "Bash", command: "Format-Volume -DriveLetter E", shellKind: "powershell" })).resolves.toMatchObject({
      riskLevel: "medium",
      shouldAsk: true
    });
    // 换行分隔与 cmd 包裹曾与 guardrail 层一起漏判
    await expect(classifier.classify({ toolName: "Bash", command: "Get-Date\r\ndel \\", shellKind: "powershell" })).resolves.toMatchObject({
      riskLevel: "medium",
      shouldAsk: true
    });
    await expect(classifier.classify({ toolName: "Bash", command: "cmd /c rd /s /q build", shellKind: "powershell" })).resolves.toMatchObject({
      riskLevel: "medium",
      shouldAsk: true
    });
  });

  test("skips PowerShell vocabulary for POSIX bash shells", async () => {
    const classifier = createPermissionClassifier();

    // 撞名真实 POSIX 命令（Elixir iex / Ruby ri）不应被 PS 词表翻成弹审
    await expect(classifier.classify({ toolName: "Bash", command: "iex -S mix phx.server", shellKind: "bash" })).resolves.toMatchObject({
      riskLevel: "low",
      shouldAsk: false
    });
    await expect(classifier.classify({ toolName: "Bash", command: "ri -T String", shellKind: "bash" })).resolves.toMatchObject({
      riskLevel: "low",
      shouldAsk: false
    });
  });

  test("keeps benign PowerShell read commands at low risk", async () => {
    const classifier = createPermissionClassifier();

    await expect(classifier.classify({
      toolName: "Bash",
      command: "Get-ChildItem -Path src"
    })).resolves.toMatchObject({
      riskLevel: "low",
      shouldAsk: false,
      reasonCode: "shell_read"
    });
    await expect(classifier.classify({
      toolName: "Bash",
      command: "Get-ChildItem | Format-Table"
    })).resolves.toMatchObject({
      riskLevel: "low",
      shouldAsk: false
    });
    // cmd 包裹的良性命令不因包裹前缀升级
    await expect(classifier.classify({
      toolName: "Bash",
      command: "cmd /c dir build"
    })).resolves.toMatchObject({
      riskLevel: "low",
      shouldAsk: false
    });
  });
});
