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
      "git show --ext-diff HEAD~1"
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
    expect(isReadOnlyPowerShell("git show HEAD")).toBeTrue();
  });
});
