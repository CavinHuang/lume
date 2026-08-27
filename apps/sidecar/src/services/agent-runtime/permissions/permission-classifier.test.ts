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

  // #720 review P1：MultiEdit 必须与 Edit 同走写审批名单，否则 dontAsk 模式
  // 下整批改文件零弹卡（探针实证过该旁路）。
  test("treats MultiEdit as a write tool on par with Edit", async () => {
    const classifier = createPermissionClassifier();

    await expect(classifier.classify({
      toolName: "MultiEdit",
      path: "/tmp/project/.env"
    })).resolves.toMatchObject({
      riskLevel: "high",
      shouldAsk: true,
      reasonCode: "sensitive_path"
    });

    // 普通路径与 Edit 同权：medium + shouldAsk（此前旁路成 low 免审）
    await expect(classifier.classify({
      toolName: "MultiEdit",
      path: "/tmp/project/src/normal.ts"
    })).resolves.toMatchObject({
      riskLevel: "medium",
      shouldAsk: true,
      reasonCode: "file_write"
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
    // iex 分支词边界钉（清单派生重构回归）：全名形态命中 medium；长单词尾部 iex
    // （maxiex）不得因前词边界丢失而误命中
    await expect(classifier.classify({ toolName: "Bash", command: "iex $script", shellKind: "powershell" })).resolves.toMatchObject({
      riskLevel: "medium",
      shouldAsk: true
    });
    await expect(classifier.classify({ toolName: "Bash", command: "cat maxiex.log", shellKind: "powershell" })).resolves.toMatchObject({
      riskLevel: "low",
      shouldAsk: false
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

  test("content signal reactivates PowerShell vocabulary on bash-configured Windows (#707)", async () => {
    const classifier = createPermissionClassifier();

    // win32 装 POSIX bash：方言读作 bash、词表曾整层休眠，Remove-Item -Recurse -Force 判 low 免审
    await expect(classifier.classify({
      toolName: "Bash",
      command: "Remove-Item -Recurse -Force build",
      shellKind: "bash",
      platform: "win32"
    })).resolves.toMatchObject({ riskLevel: "medium", shouldAsk: true });
    await expect(classifier.classify({
      toolName: "Bash",
      command: "rd /s /q build",
      shellKind: "bash",
      platform: "win32"
    })).resolves.toMatchObject({ riskLevel: "medium", shouldAsk: true });

    // -f 不构成危险标志（ri -f 是真实 Ruby docs 用法）：「删除族×标志」组合不得因单 -f 命中
    await expect(classifier.classify({
      toolName: "Bash",
      command: "ri -f Array#map",
      shellKind: "bash",
      platform: "win32"
    })).resolves.toMatchObject({ riskLevel: "low", shouldAsk: false });

    // 短别名单独出现不构成信号：POSIX 撞名防误拦口径在 win32 同样保持
    await expect(classifier.classify({
      toolName: "Bash",
      command: "iex -S mix phx.server",
      shellKind: "bash",
      platform: "win32"
    })).resolves.toMatchObject({ riskLevel: "low", shouldAsk: false });

    // 非 win32 宿主不消费信号（既定精确 bash 读法不翻转）
    await expect(classifier.classify({
      toolName: "Bash",
      command: "Remove-Item -Recurse -Force build",
      shellKind: "bash",
      platform: "linux"
    })).resolves.toMatchObject({ riskLevel: "low", shouldAsk: false });
  });

  test("uses a neutral explanation for whitelisted-out low-risk commands (#707)", async () => {
    const classifier = createPermissionClassifier();

    // 该文案经引擎 approval 透传直达审批卡，不得陈述「无风险」与「请确认」自相矛盾
    const result = await classifier.classify({ toolName: "Bash", command: "node script.js" });
    expect(result.explanation).toBe("Shell 命令不在自动放行范围内，需要用户确认");
  });

  test("uses a neutral explanation for the metadata_low fallback (#707)", async () => {
    const classifier = createPermissionClassifier();

    // skill 等词表外工具走此 fallback，default 档审批卡同样不得出现矛盾归因
    const result = await classifier.classify({ toolName: "SomeSkillTool" });
    expect(result.explanation).toBe("该操作不在自动放行范围内，需要用户确认");
  });
});
