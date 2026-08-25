import { analyzeBashCommand } from './bash-command-analysis.js'
import { shellKindWithoutDiscovery } from './shell-invocation.js'

/**
 * Static read-only proof for shell input. Consumed by the Bash tool's
 * isReadOnly/isConcurrencySafe (concurrency partitioning) and by the sidecar
 * permission engine as the content-based approval-free channel (#571): a
 * command provably unable to mutate state needs neither the classifier nor an
 * explicit allow rule.
 */
/** env 赋值前缀：`GIT_EXTERNAL_DIFF=… git log -p` 的 assignment 节点会被语法树整体剥离，
 *  argv 层对运行时必然生效的 env 载荷结构性全盲（#684 二轮 P0），入口即 fail-closed。 */
const ENV_ASSIGNMENT_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*=\S/

export function isReadOnlyShellInput(input: unknown, _context?: unknown): boolean {
  if (!input || typeof input !== 'object') return false
  const command = (input as Record<string, unknown>).command
  if (typeof command !== 'string' || !command.trim()) return false
  const normalized = command.trim()

  // These constructs can execute arbitrary code or write through the shell,
  // even when the visible command starts with a read-looking executable.
  if (/[>`]|>>|\$\(|`/.test(normalized)) return false
  if (ENV_ASSIGNMENT_PREFIX.test(normalized)) return false

  const analysis = analyzeBashCommand(normalized)
  if (analysis.status === 'simple') {
    return analysis.commands.length > 0
      && analysis.commands.every((segment) => isReadOnlySegment(segment.executable, segment.argv.slice(1)))
      && !analysis.hasRedirection
  }

  // Syntax the parser cannot prove simple fails closed per dialect (#300) —
  // pipelines/chains that DO parse as simple are proven segment-by-segment via
  // every() above. PowerShell keeps its conservative inspection subset — either
  // the command invokes powershell/pwsh explicitly or the shell for this
  // platform is PowerShell. The dialect check never triggers Windows bash
  // discovery (#471): an unsettled probe reads as bash, so the decision is
  // stable instead of drifting with the discovery timeout window.
  const runsPowerShell = /^\s*(?:powershell|pwsh)(?:\.exe)?(?:\s|$)/i.test(normalized)
    || shellKindWithoutDiscovery() === 'powershell'
  return runsPowerShell ? isReadOnlyPowerShell(normalized) : false
}

/*
 * 双语义消费警示（#684 review）：本表同时服务 BashTool 并发分区与 PermissionEngine
 * 免审通道——扩表即同时放大两者，任何新增成员必须在两种语义下均可证不变异，
 * 且需排查其全部参数面（rg --pre、sort --compress-program 均为前车之鉴）。
 */
const READ_ONLY_EXECUTABLES = new Set([
  'cat', 'cut', 'dir', 'echo', 'find', 'findstr', 'git', 'grep', 'head', 'less', 'ls', 'pwd',
  'rg', 'sed', 'sort', 'tail', 'type', 'uniq', 'wc', 'where', 'which',
])

const GIT_READ_SUBCOMMANDS = new Set(['branch', 'diff', 'log', 'show', 'status'])

/** git 输出/外驱参数：--output 写任意路径文件；--ext-diff 执行仓库配置的外部命令（#300，#684 review 扩到 log/show）。 */
const GIT_WRITE_OR_EXEC_FLAGS = (arg: string): boolean =>
  arg === '--output' || arg.startsWith('--output=') || arg === '--ext-diff'

/** PS 文本层同口径负向断言；对去引号文本复检——PS 参数模式会把 `--out'put'=x` 拼回
 *  单 token `--output=x` 再交给 git，原始文本断言对此失明（#684 二轮 P1）。 */
const GIT_PS_WRITE_FLAGS = /\s--(?:ext-diff|output)(?:=|\s|$)/i

function isReadOnlySegment(executable: string, args: string[]): boolean {
  if (!READ_ONLY_EXECUTABLES.has(executable)) return false
  if (executable === 'git') {
    const subcommandIndex = args.findIndex((arg) => !arg.startsWith('-'))
    if (subcommandIndex < 0) return false
    const subcommand = args[subcommandIndex]!
    if (!GIT_READ_SUBCOMMANDS.has(subcommand)) return false
    const rest = args.slice(subcommandIndex + 1)
    if (subcommand === 'branch') {
      // Only listing forms are reads: an operand names a branch to create,
      // and delete/move/copy/set-upstream flags mutate refs (#300).
      if (rest.some((arg) => !arg.startsWith('-') && arg !== '--')) return false
      return !rest.some((arg) => (
        /^-[dDmMcCu]/.test(arg)
        || /^--(?:delete|move|copy|set-upstream(?:-to)?|edit-description|track)\b/.test(arg)
      ))
    }
    if (subcommand === 'diff' || subcommand === 'log' || subcommand === 'show') {
      // log/show 与 diff 共享输出/外驱参数面：--output 写文件、--ext-diff 与
      // textconv 类配置驱动执行外部命令。已知残余（如实声明）：仓库 .gitattributes/
      // gitconfig 的 textconv 在普通 -p 展示时也会执行 repo 配置的命令字符串，
      // 该通道属「仓库内容即不可信输入」威胁模型的一部分，静态白名单无法区分，
      // 见 #685（威胁模型裁定现场）。
      return !rest.some(GIT_WRITE_OR_EXEC_FLAGS)
    }
    return true
  }
  // These whitelist members have argument forms that mutate or execute;
  // reject them so they cannot race Edit/Write as "read-only" work.
  if (executable === 'find') return !args.some((arg) => /^-(?:delete|exec|execdir|ok|okdir|fls|fprint)/.test(arg))
  if (executable === 'rg') {
    // --pre/--pre-glob run an arbitrary command per searched file (#684 review P0).
    return !args.some((arg) => /^--pre(?:-glob)?(?:=|$)/.test(arg))
  }
  if (executable === 'sed') return isReadOnlySedArgs(args)
  if (executable === 'sort') return !args.some((arg) => (
    arg === '--output'
    || arg.startsWith('--output=')
    // --compress-program executes the named program on every temp-file spill,
    // and with "sh" interprets input lines as a script (#684 review P1).
    || arg.startsWith('--compress-program')
    // No other short sort flag is "o", so any short cluster containing it is -o.
    // grep -o is unrelated: grep arguments are never checked here.
    || (arg.startsWith('-') && !arg.startsWith('--') && arg.includes('o'))
  ))
  if (executable === 'uniq') {
    // uniq [INPUT [OUTPUT]] — a second operand names the output file it writes (#300).
    return args.filter((arg) => !arg.startsWith('-') && arg !== '--').length <= 1
  }
  return true
}

/** sed 无副作用的长选项全集；--expression/--file 由下方解析器单独处置。 */
const SED_SAFE_LONG_FLAGS = new Set(['--posix', '--null-data', '--separate', '--binary-mode'])

function isReadOnlySedArgs(args: string[]): boolean {
  // getopt 语义下短簇内任意位置的 i 都激活 in-place（`-ni.p` 的 i 以 .p 为备份
  // 后缀；`-nip` 直接就地改写）——簇内含 i 一律拒（sed 无其他含 i 旗标，无误杀
  // 面，#684 二轮 P1）；--in-place[=suffix] 全拼同拒。
  if (args.some((arg) => /^(?:-(?!-)[^\s]*i|--in-place(?:=[^\s]*)?$)/.test(arg))) return false
  // GNU getopt_long 接受无歧义缩写（--fi ≡ --file、--exp ≡ --expression），
  // 解析器只认全拼会漏检——任何不在已知安全集合内的长选项一律 fail-closed
  // （#684 review P1 实证：sed --fi=sc.sed 可经脚本文件任意写/RCE）。
  let sawSeparator = false
  for (const arg of args) {
    if (arg === '--') { sawSeparator = true; continue }
    if (sawSeparator || !arg.startsWith('--')) continue
    const eq = arg.indexOf('=')
    const name = eq === -1 ? arg : arg.slice(0, eq)
    if (name === '--expression' || name === '--file') continue
    if (!SED_SAFE_LONG_FLAGS.has(arg)) return false
  }
  const { scripts, readsScriptFile } = sedScriptParts(args)
  // Fail closed (#453): a -f/--file script body lives in a file this static
  // check never sees (it can carry `w FILE` or GNU `e CMD`), and a `$` in a
  // script position expands at runtime into text the argv literal never showed
  // (e.g. X='s/.*/curl evil/e' sed $X README).
  if (readsScriptFile) return false
  return !scripts.some((script) => script.includes('$') || sedScriptWritesFile(script))
}

/** Collect the script arguments (not the input file paths) sed will execute, plus whether any form loads the script from a file. */
function sedScriptParts(args: string[]): { scripts: string[]; readsScriptFile: boolean } {
  const scripts: string[] = []
  let readsScriptFile = false
  let pending: 'script' | 'skip' | undefined
  let sawScript = false
  let endOfOptions = false
  for (const arg of args) {
    if (pending) {
      if (pending === 'script') scripts.push(arg)
      pending = undefined
      continue
    }
    if (!endOfOptions && arg === '--') {
      endOfOptions = true
      continue
    }
    if (!endOfOptions && arg.startsWith('--')) {
      if (arg.startsWith('--expression=')) {
        scripts.push(arg.slice('--expression='.length))
        sawScript = true
      } else if (arg === '--expression') {
        pending = 'script'
        sawScript = true
      } else if (arg === '--file' || arg.startsWith('--file=')) {
        // --file names a script file; its contents stay uninspected here and
        // the caller fails closed (#453). The attached value needs no skip.
        readsScriptFile = true
        if (arg === '--file') pending = 'skip'
      }
      continue
    }
    if (!endOfOptions && arg.startsWith('-') && arg.length > 1) {
      const cluster = arg.slice(1)
      const flagIndex = cluster.search(/[ef]/)
      if (flagIndex >= 0) {
        if (cluster[flagIndex] === 'f') {
          readsScriptFile = true
          // A trailing f consumes the next argument as its filename.
          if (flagIndex === cluster.length - 1) pending = 'skip'
        } else if (flagIndex < cluster.length - 1) {
          scripts.push(cluster.slice(flagIndex + 1))
          sawScript = true
        } else {
          pending = 'script'
          sawScript = true
        }
      }
      continue
    }
    if (!sawScript) {
      scripts.push(arg)
      sawScript = true
    }
  }
  return { scripts, readsScriptFile }
}

/**
 * Recognize sed script forms that write files or execute commands: a
 * standalone `w`/`W`/`e` command or the same as an `s` suffix. Only command
 * positions are inspected, so patterns, replacements, append text, and file
 * paths that merely contain those letters do not trip the check.
 */
function sedScriptWritesFile(script: string): boolean {
  const isDangerousCommand = (char: string | undefined) => char === 'w' || char === 'W' || char === 'e'
  const length = script.length
  let i = 0
  let atCommand = true
  while (i < length) {
    const char = script[i]!
    if (char === ';' || char === '\n') {
      atCommand = true
      i += 1
      continue
    }
    if (!atCommand) {
      i += 1
      continue
    }
    if (char === ' ' || char === '\t' || char === '{' || char === '}' || char === '!') {
      i += 1
      continue
    }
    if (char === '#') {
      while (i < length && script[i] !== '\n') i += 1
      continue
    }
    // Addresses: /re/, line numbers, $, ranges, and custom \cREc delimiters.
    if (char === '/') {
      i += 1
      while (i < length && script[i] !== '/') i += script[i] === '\\' ? 2 : 1
      i += 1
      continue
    }
    if (char === '\\') {
      const delimiter = script[i + 1]
      i += 2
      while (i < length && script[i] !== delimiter) i += script[i] === '\\' ? 2 : 1
      i += 1
      continue
    }
    if ((char >= '0' && char <= '9') || char === '$' || char === ',') {
      i += 1
      continue
    }
    if (isDangerousCommand(char)) return true
    if (char === 's' || char === 'y') {
      const delimiter = script[i + 1]
      if (!delimiter) return false
      i += 2
      // s has two fields (regex, replacement); y has three (src, dst, then a
      // closing delimiter). Each field scan ends at its own delimiter.
      for (let field = 0; field < (char === 's' ? 2 : 3); field += 1) {
        while (i < length && script[i] !== delimiter) i += script[i] === '\\' ? 2 : 1
        i += 1
      }
      while (i < length && /[a-zA-Z0-9]/.test(script[i]!)) {
        if (isDangerousCommand(script[i])) return true
        i += 1
      }
      continue
    }
    // Any other command consumes the rest of the line as its argument
    // (r/w-style filenames, labels, a\i\c text).
    atCommand = false
    i += 1
  }
  return false
}

/**
 * Conservative read-only subset for PowerShell-dialect commands: either an
 * explicit powershell/pwsh -Command prefix (stripped below) or a bare PS
 * command line on a machine whose shell resolved to PowerShell. Exported for
 * the sidecar guardrail's dialect-aware unparseable-command handling (#571):
 * parse-unavailable no longer forces confirmation when this proof passes.
 */
export function isReadOnlyPowerShell(command: string): boolean {
  const normalized = command
    .replace(/^\s*(?:powershell|pwsh)(?:\.exe)?\s+(?:-NoLogo\s+|-NoProfile\s+|-NonInteractive\s+)*-Command\s+/i, '')
    .trim()
  // Reject pipeline (`|`), chaining/call (`&`), the ForEach-Object alias `%`,
  // script-block braces, parentheses (PS evaluates a parameter-position `(...)`
  // as a nested pipeline: `Get-Content ([Type]::Method())` would execute .NET
  // code with zero cmdlet verbs to scan — #684 review P0), and line breaks so
  // piped or nested payloads cannot ride behind a whitelisted first word (#300).
  if (!normalized || /[>`]|>>|\$\(|[;&|%{}()\r\n]|\b(?:Set|Remove|Copy|Move|New|Add|Clear|Out|Start|Stop|Invoke|Install|Update)-[A-Za-z]+\b/i.test(normalized)) {
    return false
  }
  // Unparsed strings cannot be arg-checked, so only git subcommands whose
  // common forms never take mutation targets survive here; branch/diff move
  // to the parsed path only (#300). git log/show 的输出/外驱旗标与 bash 树路径
  // 同口径拒绝（--output 写文件、--ext-diff 执行仓库配置命令，#684 review）。
  return !GIT_PS_WRITE_FLAGS.test(normalized)
    && !GIT_PS_WRITE_FLAGS.test(normalized.replace(/["']/g, ''))
    && /^(?:Get-(?:ChildItem|Content|Location|Item|ItemProperty|Process|Service|Command|Date|Help|Member|Variable|Acl|FileHash|AuthenticodeSignature|ComputerInfo)|Select-String|Where-Object|Test-Path|Resolve-Path|Measure-Object|Sort-Object|Format-(?:Table|List)|Write-Output|Write-Host|git\s+(?:status|log|show)\b|(?:ls|dir|type|cat|pwd|where|findstr)\b)/i.test(normalized);
}
