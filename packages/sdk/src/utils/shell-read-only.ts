import { analyzeBashCommand } from './bash-command-analysis.js'
import { shellKindWithoutDiscovery } from './shell-invocation.js'

/**
 * Static read-only proof for shell input. Consumed by the Bash tool's
 * isReadOnly/isConcurrencySafe (concurrency partitioning) and by the sidecar
 * permission engine as the content-based approval-free channel (#571): a
 * command provably unable to mutate state needs neither the classifier nor an
 * explicit allow rule.
 */
export function isReadOnlyShellInput(input: unknown, _context?: unknown): boolean {
  if (!input || typeof input !== 'object') return false
  const command = (input as Record<string, unknown>).command
  if (typeof command !== 'string' || !command.trim()) return false
  const normalized = command.trim()

  // These constructs can execute arbitrary code or write through the shell,
  // even when the visible command starts with a read-looking executable.
  if (/[>`]|>>|\$\(|`/.test(normalized)) return false

  const analysis = analyzeBashCommand(normalized)
  if (analysis.status === 'simple') {
    return analysis.commands.length > 0
      && analysis.commands.every((segment) => isReadOnlySegment(segment.executable, segment.argv.slice(1)))
      && !analysis.hasRedirection
  }

  // Non-provable syntax falls back per dialect (#300): Bash has no safe
  // fallback (compound and piped forms escape any first-word whitelist), so it
  // fails closed. PowerShell keeps its conservative inspection subset — either
  // the command invokes powershell/pwsh explicitly or the shell for this
  // platform is PowerShell. The dialect check never triggers Windows bash
  // discovery (#471): an unsettled probe reads as bash, so the decision is
  // stable instead of drifting with the discovery timeout window.
  const runsPowerShell = /^\s*(?:powershell|pwsh)(?:\.exe)?(?:\s|$)/i.test(normalized)
    || shellKindWithoutDiscovery() === 'powershell'
  return runsPowerShell ? isReadOnlyPowerShell(normalized) : false
}

const READ_ONLY_EXECUTABLES = new Set([
  'cat', 'cut', 'dir', 'echo', 'find', 'findstr', 'git', 'grep', 'head', 'less', 'ls', 'pwd',
  'rg', 'sed', 'sort', 'tail', 'type', 'uniq', 'wc', 'where', 'which',
])

function isReadOnlySegment(executable: string, args: string[]): boolean {
  if (!READ_ONLY_EXECUTABLES.has(executable)) return false
  if (executable === 'git') {
    const subcommandIndex = args.findIndex((arg) => !arg.startsWith('-'))
    if (subcommandIndex < 0) return false
    const subcommand = args[subcommandIndex]!
    if (!new Set(['branch', 'diff', 'log', 'show', 'status']).has(subcommand)) return false
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
    if (subcommand === 'diff') {
      // --output writes the diff to a file; --ext-diff executes a
      // repo-config-controlled external diff command (#300).
      return !rest.some((arg) => arg === '--output' || arg.startsWith('--output=') || arg === '--ext-diff')
    }
    return true
  }
  // These whitelist members have argument forms that mutate or execute;
  // reject them so they cannot race Edit/Write as "read-only" work.
  if (executable === 'find') return !args.some((arg) => /^-(?:delete|exec|execdir|ok|okdir|fls|fprint)/.test(arg))
  if (executable === 'sed') return isReadOnlySedArgs(args)
  if (executable === 'sort') return !args.some((arg) => (
    arg === '--output'
    || arg.startsWith('--output=')
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

function isReadOnlySedArgs(args: string[]): boolean {
  if (args.some((arg) => /^(-i|--in-place)/.test(arg))) return false
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
  // script-block braces, and line breaks so piped or nested payloads cannot
  // ride behind a whitelisted first word (#300).
  if (!normalized || /[>`]|>>|\$\(|[;&|%{}\r\n]|\b(?:Set|Remove|Copy|Move|New|Add|Clear|Out|Start|Stop|Invoke|Install|Update)-[A-Za-z]+\b/i.test(normalized)) {
    return false
  }
  // Unparsed strings cannot be arg-checked, so only git subcommands whose
  // common forms never take mutation targets survive here; branch/diff move
  // to the parsed path only (#300).
  return /^(?:Get-(?:ChildItem|Content|Location|Item|ItemProperty|Process|Service|Command|Date|Help|Member|Variable|Acl|FileHash|AuthenticodeSignature|ComputerInfo)|Select-String|Where-Object|Test-Path|Resolve-Path|Measure-Object|Sort-Object|Format-(?:Table|List)|Write-Output|Write-Host|git\s+(?:status|log|show)\b|(?:ls|dir|type|cat|pwd|where|findstr)\b)/i.test(normalized)
}
