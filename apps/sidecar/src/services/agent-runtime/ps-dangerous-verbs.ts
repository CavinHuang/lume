/*
 * PowerShell 危险动词共享词表：guardrail 正则层（guardrails/runtime-tool-safety）与启发式
 * 分类器（permissions/permission-classifier）共同消费。动词集合只在此维护，两层各自组合
 * 匹配形态（正则层带锚点与标志细节，分类器用粗粒度模式）。新增动词必须同步补充探针，
 * 跨层一致性由 ps-dangerous-verbs.test 遍历断言钉死，防止单侧静默漂移（format-* 曾只进一层）。
 */

/** PS 命令位锚点：命令首、子命令/管道分隔符或换行之后（换行是多行脚本的命令分隔符） */
export const PS_ANCHOR = String.raw`(?:^|[;&|(\r\n]\s*)`;

/*
 * cmd.exe /c|/k 包裹前缀：内层命令按同一词表识别。容忍引号包裹的可执行名（"cmd"）、
 * /c|/k 前的任意开关与重复（cmd /s /c、合并旗标、无空格 cmd/c），外层 + 使多层嵌套
 * 包裹（cmd /c cmd /c …）整体可匹配。首段仍须经 PS_ANCHOR 定位到真实命令边界。
 */
export const CMD_WRAP_ANCHOR = String.raw`${PS_ANCHOR}(?:"?cmd(?:\.exe)?"?\s*(?:\/[^\s"]+\s+)*\/[ck]\s*["']?\s*)+`;

/** 确认组共用锚点：命令位或 cmd 包裹内层（与删除族同源，防止包裹识别只覆盖单侧规则组） */
export const PS_CONFIRM_COMMAND = String.raw`(?:${PS_ANCHOR}|${CMD_WRAP_ANCHOR})`;

/** PS 删除族在命令位的完整锚点：Remove-Item 及别名（rd/rmdir/del/erase/ri），含 cmd 包裹内层 */
export const PS_DELETE_COMMAND = String.raw`(?:${PS_ANCHOR}|${CMD_WRAP_ANCHOR})(?:remove-item|rd|rmdir|del|erase|ri)\b`;

/** 停止进程/服务/系统类动词 */
export const PS_STOP_VERBS = String.raw`(?:stop-process|stop-service|stop-computer|restart-computer)`;

/** 执行策略与动态执行动词 */
export const PS_DYNAMIC_EXEC_VERBS = String.raw`(?:set-executionpolicy|invoke-expression|iex)`;

/** 格式化动词（Format-Table/List/Wide 是高频良性输出格式化，刻意不纳入） */
export const PS_FORMAT_VERBS = String.raw`(?:format-volume|format-disk)`;

/** 清空文件内容动词 */
export const PS_CLEAR_CONTENT_VERBS = String.raw`(?:clear-content)`;

/** 删除族危险标志：-Recurse/-Force 及其最小缩写（-re/-fo）、cmd 风格 /s /q；命名参数与 -WhatIf 干跑旗标不触发 */
export const PS_DANGEROUS_DELETE_FLAGS = String.raw`(?:-{1,2}re(?:curse)?\b|-{1,2}fo(?:rce)?\b|\/[sq]\b)`;

/** 分类器全名词表（无锚点、\b 边界即可命中）；短别名由 PS_DELETE_COMMAND 锚定兜底，防 npm ri 之类子命令误判 */
export const PS_FULL_NAME_VERBS = String.raw`(?:remove-item|clear-content|stop-process|stop-service|stop-computer|restart-computer|set-executionpolicy|invoke-expression|iex|format-volume|format-disk)`;

/*
 * 内容信号（#707）：win32 装 POSIX bash 的机器上方言读作 bash，词表按方言门控整层休眠，
 * Remove-Item -Recurse -Force 一类命令会漏判为 low。命令文本自身呈现强 PS 形态时应无视
 * 方言激活词表。信号只收两类无 POSIX 撞名读法的形态：
 * - 全名 Verb-Noun 动词（连字符形态为 PS 独有）；刻意不含短别名 iex（Elixir REPL）等
 * - 「删除族动词 + 危险标志」组合（rd /s /q 等；POSIX 下该参数形态不是合法读法）
 * 与方言门控的初衷一致：iex/ri 单独出现不构成信号。
 */
export const PS_CONTENT_SIGNAL = new RegExp(
  String.raw`\b(?:remove-item|clear-content|stop-process|stop-service|stop-computer|restart-computer|set-executionpolicy|invoke-expression|format-volume|format-disk)\b|${PS_DELETE_COMMAND}[^\r\n;&|]*[^\S\r\n]${PS_DANGEROUS_DELETE_FLAGS}`,
  "i"
);

/** win32 平台上叠加于方言判定的词表激活信号；非 win32 宿主不消费（见 ps-dangerous-verbs.test 钉住的既定语义） */
export function hasPowerShellContentSignal(command: string): boolean {
  return PS_CONTENT_SIGNAL.test(command);
}

/** 跨层一致性探针：覆盖每个词表组与每种锚定形态的代表性命令，两层都必须命中 */
export const PS_DANGEROUS_PROBES: string[] = [
  "Remove-Item -Force build.log",
  "rd /s /q build",
  "cmd /c rd /s /q build",
  "cmd /c del /q cache.txt",
  // cmd 包裹变体：嵌套包裹、/c 前旗标、引号可执行名（曾双层全漏）
  "cmd /c cmd /c rd /s /q build",
  "cmd /s /c del \\",
  '"cmd" /c ri ~',
  "Get-Date\ndel \\",
  "Get-Date\r\nRemove-Item ~",
  "Stop-Process -Name node",
  "Set-ExecutionPolicy RemoteSigned",
  "Invoke-Expression $script",
  "Format-Volume -DriveLetter E",
  "Clear-Content app.log",
  // 各确认组的 cmd 包裹形态（包裹识别曾只并入删除族）
  "cmd /s /c stop-computer",
  "cmd /c set-executionpolicy remotesigned",
  "cmd /c format-volume E:",
  "cmd /c clear-content app.log"
];
