/*
 * PowerShell 危险动词共享词表：guardrail 正则层（guardrails/runtime-tool-safety）与启发式
 * 分类器（permissions/permission-classifier）共同消费。动词集合只在此维护，两层各自组合
 * 匹配形态（正则层带锚点与标志细节，分类器用粗粒度模式）。新增动词必须同步补充探针，
 * 跨层一致性由 ps-dangerous-verbs.test 遍历断言钉死，防止单侧静默漂移（format-* 曾只进一层）。
 */

/** PS 命令位锚点：命令首、子命令/管道分隔符或换行之后（换行是多行脚本的命令分隔符） */
export const PS_ANCHOR = String.raw`(?:^|[;&|(\r\n]\s*)`;

/** cmd.exe /c|/k 包裹前缀：内层命令按同一词表识别 */
export const CMD_WRAP_ANCHOR = String.raw`(?:^|[;&|(\r\n]\s*)cmd(?:\.exe)?\s+\/[ck]\s*["']?`;

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

/** 跨层一致性探针：覆盖每个词表组与每种锚定形态的代表性命令，两层都必须命中 */
export const PS_DANGEROUS_PROBES: string[] = [
  "Remove-Item -Force build.log",
  "rd /s /q build",
  "cmd /c rd /s /q build",
  "cmd /c del /q cache.txt",
  "Get-Date\ndel \\",
  "Get-Date\r\nRemove-Item ~",
  "Stop-Process -Name node",
  "Set-ExecutionPolicy RemoteSigned",
  "Invoke-Expression $script",
  "Format-Volume -DriveLetter E",
  "Clear-Content app.log"
];
