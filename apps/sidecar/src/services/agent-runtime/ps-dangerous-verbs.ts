/*
 * PowerShell 危险动词共享词表：guardrail 正则层（guardrails/runtime-tool-safety）与启发式
 * 分类器（permissions/permission-classifier）共同消费。动词集合只在此维护，两层各自组合
 * 匹配形态（正则层带锚点与标志细节，分类器用粗粒度模式）。新增动词必须同步补充探针，
 * 跨层一致性由 ps-dangerous-verbs.test 遍历断言钉死，防止单侧静默漂移（format-* 曾只进一层）。
 */

/** PS 命令位锚点：命令首、子命令/管道分隔符、赋值号（$x = <cmd> 右侧真实执行）、脚本块起始
 *  或换行之后（换行是多行脚本的命令分隔符；{ 使脚本块内命令位锚定，防 { del ~ } 形态绕过
 *  词表）。\\s* 作用于全部分支——行首缩进（^ 后空白）同样是命令位。刻意不含空格成员：
 *  参数位置（空格分隔）不是命令位，echo 回显文本不得触发词表。= 成员的已知误伤面是
 *  「文本中 = 紧跟动词」的形态：全名动词参数值（--format=stop-process）与短别名紧贴等号
 *  （sed 's/a=del/b/'、make VARIANT=erase），频率低且方向 fail-closed（多弹一次卡） */
export const PS_ANCHOR = String.raw`(?:^|[;&|({=\r\n])\s*`;

/*
 * cmd.exe /c|/k 包裹前缀：内层命令按同一词表识别。容忍引号包裹的可执行名（"cmd"）、
 * /c|/k 前的任意开关与重复（cmd /s /c、合并旗标、无空格 cmd/c），外层 + 使多层嵌套
 * 包裹（cmd /c cmd /c …）整体可匹配。首段仍须经 PS_ANCHOR 定位到真实命令边界。
 */
export const CMD_WRAP_ANCHOR = String.raw`${PS_ANCHOR}(?:"?cmd(?:\.exe)?"?\s*(?:\/[^\s"]+\s+)*\/[ck]\s*["']?\s*)+`;

/**
 * 显式 powershell/pwsh 可执行前缀：-Command 类参数位的载荷按词表识别（镜像 SDK
 * parse-unavailable 短路的可执行名读法）。此前靠锚集误含空格才意外覆盖该形态，
 * 修正锚集后需显式入锚——否则方言机 pwsh -Command Remove-Item C:\ 从硬拒降为通用确认。
 * 头部兼收 CMD_WRAP：cmd /c pwsh -Command "…" 复合包裹的内层载荷同属执行位。
 * 尾部 ["']? 容忍引号包裹载荷的起始引号（引号内即执行的脚本，词表判定方向正确）；
 * 引号内分号分隔的后续命令由 ; 锚独立覆盖。
 */
export const PS_EXPLICIT_PREFIX = String.raw`(?:${PS_ANCHOR}|${CMD_WRAP_ANCHOR})\s*(?:powershell|pwsh)(?:\.exe)?\b(?:\s+-[^\s]+)*\s+["']?`;

/** 确认组共用锚点：命令位、cmd 包裹内层或显式 powershell 前缀载荷位（三支同源，防单侧漂移） */
export const PS_CONFIRM_COMMAND = String.raw`(?:${PS_ANCHOR}|${CMD_WRAP_ANCHOR}|${PS_EXPLICIT_PREFIX})`;

/** PS 删除族在命令位的完整锚点：Remove-Item 及别名（rd/rmdir/del/erase/ri）。
 *  锚与确认组同源（命令位/cmd 包裹内层/pwsh 载荷位），防单侧漂移 */
export const PS_DELETE_COMMAND = String.raw`${PS_CONFIRM_COMMAND}(?:remove-item|rd|rmdir|del|erase|ri)\b`;

/** 停止进程/服务/系统类动词 */
export const PS_STOP_VERBS = String.raw`(?:stop-process|stop-service|stop-computer|restart-computer)`;

/** 执行策略与动态执行动词 */
export const PS_DYNAMIC_EXEC_VERBS = String.raw`(?:set-executionpolicy|invoke-expression|iex)`;

/** 格式化动词（Format-Table/List/Wide 是高频良性输出格式化，刻意不纳入） */
export const PS_FORMAT_VERBS = String.raw`(?:format-volume|format-disk)`;

/** 清空文件内容动词 */
export const PS_CLEAR_CONTENT_VERBS = String.raw`(?:clear-content)`;

/** 删除族危险标志：-Recurse/-Force 及其前缀缩写（-r/-re/-rec/-fo）、cmd 风格 /s /q
 *  （含连写 /sq /qs——cmd 开关解析接受合并形态）；命名参数与 -WhatIf 干跑旗标不触发。
 *  缩写必须逐级枚举：r(?:e(?:curse)?)?\b 一类的嵌套可选组会把 -re/-rec 挤出命中面
 *  （回溯后 \b 落在 word char 之间必败）。Force 缩写下限是 -fo：单 -f 会误拦 ri -f
 *  （真实 Ruby docs 用法，ri 在删除族词表内） */
export const PS_DANGEROUS_DELETE_FLAGS = String.raw`(?:-{1,2}(?:r|re|rec|recurse)\b|-{1,2}fo(?:rce)?\b|\/[sq]{1,2}\b)`;

/** 无歧义全名动词基础清单：连字符 Verb-Noun 形态为 PS 独有，POSIX 无撞名读法。
 *  单一事实来源——分类器全名词表与内容信号均由此派生，新增动词只改这里 */
const PS_UNAMBIGUOUS_FULL_NAME_VERBS = String.raw`(?:remove-item|clear-content|stop-process|stop-service|stop-computer|restart-computer|set-executionpolicy|invoke-expression|format-volume|format-disk)`;

/** 分类器全名词表（无锚点、\b 边界即可命中）＝无歧义基础 + iex；短别名由 PS_DELETE_COMMAND 锚定兜底，
 *  防 npm ri 之类子命令误判。自包含 (?:) 组：消费端正则按 `\b${...}\b` 插值，裸拼接会让
 *  iex 分支丢失前词边界（maxiex 之类尾部误命中） */
export const PS_FULL_NAME_VERBS = String.raw`(?:${PS_UNAMBIGUOUS_FULL_NAME_VERBS}|iex)`;

/*
 * 内容信号（#707）：win32 装 POSIX bash 的机器上方言读作 bash，词表按方言门控整层休眠，
 * Remove-Item -Recurse -Force 一类命令会漏判为 low。命令文本自身呈现强 PS 形态时应无视
 * 方言激活词表。信号只收两类无 POSIX 撞名读法的形态：
 * - 命令位上的无歧义全名动词（派生自基础清单，经 PS_CONFIRM_COMMAND 定位命令位或 cmd
 *   包裹内层；参数/字符串位置的动词文本如 echo 'remove-item ...' 不构成信号）
 * - 「删除族动词 + 危险标志」组合（rd /s /q 等；POSIX 下该参数形态不是合法读法）
 * 与方言门控的初衷一致：iex/ri 单独出现不构成信号。
 *
 * 口径差异（守卫 vs 分类器）：guardrail 以原始文本匹配（锚点含换行），分类器收到的
 * 是经 permission-rules normalizeWhitespace 折行的文本——heredoc 等多行形态在分类器
 * 侧丢失换行锚点、信号可能转 false，由 gateway 合并语义（守卫层原文复核优先）兜底。
 */
export const PS_CONTENT_SIGNAL = new RegExp(
  String.raw`${PS_CONFIRM_COMMAND}${PS_UNAMBIGUOUS_FULL_NAME_VERBS}\b|${PS_DELETE_COMMAND}[^\r\n;&|]*[^\S\r\n]${PS_DANGEROUS_DELETE_FLAGS}`,
  "i"
);

/** win32 平台上叠加于方言判定的词表激活信号；非 win32 宿主不消费（见 ps-dangerous-verbs.test 钉住的既定语义） */
export function hasPowerShellContentSignal(command: string): boolean {
  return PS_CONTENT_SIGNAL.test(command);
}

/** 跨层一致性探针：覆盖每个词表组与每种锚定形态的代表性命令，两层都必须命中 */
export const PS_DANGEROUS_PROBES: string[] = [
  "Remove-Item -Force build.log",
  "Remove-Item -r build",
  // 中缀缩写逐级钉死（曾因嵌套可选组回归丢失 -re 命中）；连写合并开关
  "ri -re build",
  "rd -rec dist",
  "rd /sq build",
  "rmdir /qs .cache",
  // 赋值执行位（= 锚：右侧真实执行）；cmd 包裹接续 pwsh 前缀的复合形态（并列锚曾无法表达串联）
  "$x = Remove-Item ~",
  'cmd /c pwsh -Command "Remove-Item ~"',
  // 显式 powershell 前缀的引号包裹载荷
  'pwsh -Command "Remove-Item ~"',
  // 行首空白缩进命令位（锚集去空格成员后 ^ 分支须自带 \s*，曾单前导空格击穿词表）
  "  del /s /q build",
  // 显式 powershell 前缀的裸载荷（-Command 参数位的动词按词表识别）
  "pwsh -NoProfile -Command Remove-Item C:\\",
  // 脚本块内命令位（PS_ANCHOR 的 { 锚）；括号包裹的主目录裸目标
  "{ rd /s /q build }",
  "Remove-Item ($home)",
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
