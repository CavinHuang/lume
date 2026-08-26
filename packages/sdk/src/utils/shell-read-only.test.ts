import { describe, expect, test } from "bun:test";
import { isNativeAvailable } from "@lume/natives";
import { isReadOnlyPowerShell, isReadOnlyShellInput } from "./shell-read-only.js";

/**
 * #684 review 安全向量的钉子集：每个向量都是曾被证明可穿透免审通道的真实
 * 变异形态，修复后必须恒为 false。PS 前缀形态走纯正则（无 natives 产物环境
 * 与本地双态确定）；bash 树形态依赖语法树，skipIf 守护与仓内惯例一致。
 */
describe("shell read-only proof — security vectors (#684 review)", () => {
  test("PowerShell parameter-position parentheses are rejected (nested pipeline / .NET static calls)", () => {
    const vectors = [
      'powershell -Command Get-Content ([System.Diagnostics.Process]::Start("calc"))',
      "Get-Content ([System.IO.File]::WriteAllText('C:/x/pwn.txt','owned'))",
      "(iex (Get-Content script.ps1))",
      "Get-ChildItem (ri ./important)"
    ];
    for (const command of vectors) {
      expect(isReadOnlyShellInput({ command })).toBeFalse();
      // 裸 PS 形态直接过白名单函数（显式前缀剥离后等价）
      if (!command.startsWith("powershell")) {
        expect(isReadOnlyPowerShell(command)).toBeFalse();
      }
    }
  });

  test.skipIf(!isNativeAvailable())("rg --pre / sort --compress-program / sed long-option abbreviations are rejected", () => {
    const vectors = [
      'rg --pre "sh -c id" pattern .',
      "rg --pre=cmd pattern .",
      "sort --compress-program=sh big.txt",
      "sed --fi=payload.sed in.txt",
      "sed --exp=s/^/#/w in.txt"
    ];
    for (const command of vectors) {
      expect(isReadOnlyShellInput({ command })).toBeFalse();
    }
  });

  test.skipIf(!isNativeAvailable())("git log/show inherit the diff-family output/exec exclusions", () => {
    for (const command of [
      "git log --output=pwned.txt -5",
      "git show --output=m.txt HEAD",
      "git log -p --ext-diff",
      "git show --ext-diff HEAD~1",
      // #685 裁定：显式 --textconv 触发仓库配置的转换命令，fail-closed
      "git log -p --textconv",
      "git diff --textconv HEAD~1"
    ]) {
      expect(isReadOnlyShellInput({ command })).toBeFalse();
    }
    // 对照：良性 git log/show 仍放行
    expect(isReadOnlyShellInput({ command: "git log --oneline -5" })).toBeTrue();
  });

  test("explicit-prefix git forms keep the same output/exec exclusion without the parser", () => {
    // PS 前缀剥离后的 git 白名单分支同样纯正则可判，双态确定
    expect(isReadOnlyShellInput({ command: "powershell -Command git show --output=x HEAD" })).toBeFalse();
    expect(isReadOnlyPowerShell("git show --ext-diff HEAD")).toBeFalse();
    // #685：PS 文本层同口径拒显式 textconv
    expect(isReadOnlyPowerShell("git log --textconv -p")).toBeFalse();
    expect(isReadOnlyPowerShell("git show HEAD")).toBeTrue();
  });

  test("env assignment prefixes fail closed at the entry (round-2 H1 P0)", () => {
    // tree-sitter 把 variable_assignment 整体剥离出 argv：`GIT_EXTERNAL_DIFF=… git log -p`
    // 在白名单眼里只剩 `git log -p`——入口正则双态确定，不依赖语法树
    const vectors = [
      "GIT_EXTERNAL_DIFF=calc git log -p",
      "RIPGREP_CONFIG_PATH=/tmp/x.cfg rg pattern .",
      "FOO=bar git status",
      "A=1 B=2 cat /etc/passwd"
    ];
    for (const command of vectors) {
      expect(isReadOnlyShellInput({ command })).toBeFalse();
    }
  });

  test("PowerShell quote-splicing cannot hide git write flags from the text-layer check (round-2 H2)", () => {
    // PS 参数模式把 `--out'put'=x` 拼回单 token 再交给 git；去引号二次断言封口，
    // 纯文本层路径，无产物环境与本地双态确定
    const vectors = [
      "powershell -NoProfile -NonInteractive -Command git log --out'put'=pwned.txt",
      'pwsh -NoProfile -Command git log --out"put=pwned.txt"',
      "powershell -Command git show --ex't-diff'"
    ];
    for (const command of vectors) {
      expect(isReadOnlyShellInput({ command })).toBeFalse();
    }
    expect(isReadOnlyPowerShell("git log --out'put'=x.txt")).toBeFalse();
  });

  test.skipIf(!isNativeAvailable())("sed short clusters containing i are rejected wherever the letter sits (round-2 H3)", () => {
    const vectors = [
      "sed -ni.p 's/a/X/' t.txt",
      "sed -nip 's/a/X/' t.txt",
      "echo hi; sed -ni.p 's/a/X/' f.txt",
      "sed '-i.bak' 's/a/X/' t.txt"
    ];
    for (const command of vectors) {
      expect(isReadOnlyShellInput({ command })).toBeFalse();
    }
    // 对照：不含 i 的良性短簇仍放行
    expect(isReadOnlyShellInput({ command: "sed -n '10p' file.txt" })).toBeTrue();
  });
});
