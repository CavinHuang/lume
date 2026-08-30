/**
 * Git 状态面板服务（只读）—— main 进程侧 git CLI 执行体。
 *
 * 语义对齐 ZCode SidePane Git 面板数据面（docs/analysis/P2-git-codeviewer.md §1、
 * Q5 git 执行层闭环）：
 *  - status：`status --porcelain=v2 --branch --untracked-files=all -z` 解析分支头
 *    （ahead/behind）与三类变更（unstaged/staged/untracked），行数来自 `diff --numstat -z`；
 *  - diff：单文件 unified patch（staged 加 --cached，untracked 用 --no-index /dev/null），
 *    懒加载由 renderer 控制，本层不做缓存；
 *  - 只读：不提供 stage/unstage/commit 任何写操作（面板语义）。
 *
 * 执行加固（Q5）：
 *  - spawn 参数数组、无 shell；15s 超时；windowsHide；
 *  - 环境剥离 GIT_DIR/GIT_INDEX_FILE/GIT_CONFIG/GIT_WORK_TREE（防指向外部仓库），
 *    GIT_PAGER=cat / LC_ALL=C / GIT_TERMINAL_PROMPT=0 保证输出稳定非交互；
 *  - 输出按水位截断（status 16MB / diff 512KB），超限 kill 并标记。
 *
 * 语义偏差：
 *  1. diff 通道名沿用 `lume:browser-git-*` 前缀（挂在浏览器面板通道族下，同侧栏面板家族）；
 *  2. untracked 文件的 added/removed 不单独跑 --no-index numstat（N 个文件 N 次进程），
 *     置 null，renderer 不显示行数；
 *  3. --no-index 退出码 1 = 有差异（git 约定），按成功处理。
 */

import { spawn } from 'node:child_process'
import path from 'node:path'
import {
  GIT_PANEL_IPC_CHANNELS,
  type GitPanelChange,
  type GitPanelChangeKind,
  type GitPanelDiff,
  type GitPanelSection,
  type GitPanelStatus,
} from '@lume/shared'

const GIT_TIMEOUT_MS = 15_000
const STATUS_MAX_OUTPUT_BYTES = 16 * 1024 * 1024
const DIFF_MAX_OUTPUT_BYTES = 512 * 1024

/** 渲染层→main 的 IPC 入口（main.ts dispatchCommand 前缀转发到这里）。 */
export async function handleGitPanelCommand(command: string, payload: Record<string, unknown>): Promise<unknown> {
  if (command === GIT_PANEL_IPC_CHANNELS.status) {
    return getGitPanelStatus(parseNonEmptyString(payload.workspacePath, 'workspacePath'))
  }
  if (command === GIT_PANEL_IPC_CHANNELS.diff) {
    return getGitPanelDiff(
      parseNonEmptyString(payload.workspacePath, 'workspacePath'),
      parseNonEmptyString(payload.path, 'path'),
      parseDiffSection(payload.section),
    )
  }
  throw new Error(`unsupported git-panel command: ${command}`)
}

/* ── 状态概要 ─────────────────────────────────────────────────────────── */

export async function getGitPanelStatus(workspacePath: string): Promise<GitPanelStatus> {
  const unavailable: GitPanelStatus = {
    isGitAvailable: false,
    isRepository: false,
    branchName: null,
    ahead: 0,
    behind: 0,
    isDirty: false,
    changes: [],
  }
  // git 可用性与工作目录无关：cwd 不指向 workspace，目录不存在时不会误报「git 不可用」。
  const version = await runGit(['--version'], process.cwd(), { maxOutputBytes: STATUS_MAX_OUTPUT_BYTES })
  if (version.failure) return unavailable

  const topLevel = await runGit(['rev-parse', '--show-toplevel'], workspacePath, { maxOutputBytes: STATUS_MAX_OUTPUT_BYTES })
  if (topLevel.failure || topLevel.code !== 0) {
    return { ...unavailable, isGitAvailable: true }
  }
  const repoRoot = path.resolve(topLevel.stdout.trim())

  const [status, worktreeNumstat, cachedNumstat] = await Promise.all([
    runGit(['status', '--porcelain=v2', '--branch', '--untracked-files=all', '-z'], repoRoot, { maxOutputBytes: STATUS_MAX_OUTPUT_BYTES }),
    runGit(['diff', '--numstat', '-z'], repoRoot, { maxOutputBytes: STATUS_MAX_OUTPUT_BYTES }),
    runGit(['diff', '--cached', '--numstat', '-z'], repoRoot, { maxOutputBytes: STATUS_MAX_OUTPUT_BYTES }),
  ])
  if (status.failure || status.code !== 0 || status.truncated) {
    return { ...unavailable, isGitAvailable: true, isRepository: true }
  }

  const parsed = parseGitStatus(status.stdout)
  const changes = assembleChanges(parsed.entries, parseNumstat(worktreeNumstat.stdout), parseNumstat(cachedNumstat.stdout), repoRoot, workspacePath)
  return {
    isGitAvailable: true,
    isRepository: true,
    branchName: parsed.branch.branchName,
    ahead: parsed.branch.ahead,
    behind: parsed.branch.behind,
    isDirty: changes.length > 0,
    changes,
  }
}

/* ── 单文件 diff（懒加载） ────────────────────────────────────────────── */

export async function getGitPanelDiff(workspacePath: string, file: string, section: GitPanelSection): Promise<GitPanelDiff> {
  const topLevel = await runGit(['rev-parse', '--show-toplevel'], workspacePath, { maxOutputBytes: STATUS_MAX_OUTPUT_BYTES })
  if (topLevel.failure || topLevel.code !== 0) throw new Error('not a git repository')
  const repoRoot = path.resolve(topLevel.stdout.trim())

  const args = section === 'staged'
    ? ['diff', '--cached', '--no-ext-diff', '--no-color', '--', file]
    : section === 'untracked'
      ? ['diff', '--no-index', '--no-ext-diff', '--no-color', '--', '/dev/null', file]
      : ['diff', '--no-ext-diff', '--no-color', '--', file]
  const result = await runGit(args, repoRoot, { maxOutputBytes: DIFF_MAX_OUTPUT_BYTES })
  // --no-index 约定：0 = 无差异，1 = 有差异，>1 = 真错误。
  const ok = section === 'untracked' ? result.code >= 0 && result.code <= 1 : result.code === 0
  if (result.failure || !ok) throw new Error(`git diff failed (exit ${result.code})`)

  if (result.truncated) return { availability: 'truncated', patch: result.stdout }
  if (/^Binary files .* differ$/m.test(result.stdout)) return { availability: 'binary', patch: '' }
  return { availability: 'patch', patch: result.stdout }
}

/* ── git 进程执行 ─────────────────────────────────────────────────────── */

interface GitRunResult {
  code: number
  stdout: string
  stderr: string
  /** timeout = 超时 kill；spawn = 进程启动失败（git 不存在/cwd 不存在等）。 */
  failure: 'timeout' | 'spawn' | null
  /** stdout 超过 maxOutputBytes 被截断（截断后 kill）。 */
  truncated: boolean
}

function runGit(args: string[], cwd: string, options: { timeoutMs?: number; maxOutputBytes: number }): Promise<GitRunResult> {
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn('git', args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: hardenedGitEnv(),
        windowsHide: true,
      })
    } catch {
      resolve({ code: -1, stdout: '', stderr: '', failure: 'spawn', truncated: false })
      return
    }

    let stdout = ''
    let stderr = ''
    let stdoutBytes = 0
    let truncated = false
    let settled = false
    const finish = (result: GitRunResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish({ code: -1, stdout: '', stderr: '', failure: 'timeout', truncated: false })
    }, timeoutMs)

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (truncated || settled) return
      stdoutBytes += Buffer.byteLength(chunk, 'utf8')
      if (stdoutBytes <= options.maxOutputBytes) {
        stdout += chunk
      } else {
        truncated = true
        child.kill()
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.on('error', () => {
      child.kill()
      finish({ code: -1, stdout: '', stderr: '', failure: 'spawn', truncated: false })
    })
    child.on('close', (code) => {
      finish({
        code: code ?? -1,
        stdout,
        stderr,
        failure: null,
        truncated,
      })
    })
  })
}

/** 按 NUL 拆记录（-z 输出末尾总带一个 NUL；容忍缺失）。 */
function splitNulRecords(output: string): string[] {
  const body = output.endsWith('\0') ? output.slice(0, -1) : output
  return body.length === 0 ? [] : body.split('\0')
}

/** git 环境加固：剥离可劫持仓库定位的变量，固定分页器/locale/禁止交互凭据提示。 */
export function hardenedGitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base }
  for (const key of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_CONFIG', 'GIT_WORK_TREE']) {
    delete env[key]
  }
  env.GIT_PAGER = 'cat'
  env.LC_ALL = 'C'
  env.GIT_TERMINAL_PROMPT = '0'
  return env
}

/* ── porcelain v2 解析（纯函数，单测钉死） ───────────────────────────── */

/** `#` 分支头 + 变更条目（-z 下记录间 NUL 分隔；`2` 重命名记录额外跟一个 origPath token）。 */
export interface ParsedGitStatus {
  branch: { branchName: string | null; ahead: number; behind: number }
  entries: ParsedStatusEntry[]
}

export interface ParsedStatusEntry {
  /** index 侧状态字母（'?'/'u' 记录为 ' '）。 */
  x: string
  /** worktree 侧状态字母。 */
  y: string
  /** 仓库根相对路径（untracked/普通条目）；重命名为新路径。 */
  path: string
  /** 重命名原路径（仅 `2` 记录）。 */
  origPath?: string
}

/** 解析 `status --porcelain=v2 --branch -z` 输出。 */
export function parseGitStatus(output: string): ParsedGitStatus {
  const tokens = splitNulRecords(output)
  const branch = { branchName: null as string | null, ahead: 0, behind: 0 }
  const entries: ParsedStatusEntry[] = []

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] as string
    if (token.startsWith('# branch.head ')) {
      const name = token.slice('# branch.head '.length)
      branch.branchName = name === '(detached)' ? null : name
      continue
    }
    if (token.startsWith('# branch.ab ')) {
      const match = /# branch\.ab \+(\d+) -(\d+)/.exec(token)
      if (match) {
        branch.ahead = Number(match[1])
        branch.behind = Number(match[2])
      }
      continue
    }
    if (token.startsWith('#')) continue

    // 变更记录：<type> <XY> <sub> <m*> <h*> ... <path>；字段间单空格。
    const spaceAt = token.indexOf(' ')
    if (spaceAt <= 0) continue
    const type = token.slice(0, spaceAt)
    const fields = token.slice(spaceAt + 1).split(' ')

    if (type === '1' && fields.length >= 8) {
      entries.push({ x: fields[0]!.charAt(0), y: fields[0]!.charAt(1), path: fields.slice(7).join(' ') })
      continue
    }
    if (type === '2' && fields.length >= 9) {
      const path = fields.slice(8).join(' ')
      const origPath = tokens[i + 1]
      if (typeof origPath === 'string') i += 1
      entries.push({ x: fields[0]!.charAt(0), y: fields[0]!.charAt(1), path, ...(typeof origPath === 'string' ? { origPath } : {}) })
      continue
    }
    if (type === 'u' && fields.length >= 10) {
      // 冲突条目：XY 两位均可为不同 U 阶段；面板按 worktree 视角展示为 conflicted。
      entries.push({ x: 'U', y: 'U', path: fields.slice(9).join(' ') })
      continue
    }
    if (type === '?' && fields.length >= 1) {
      entries.push({ x: '?', y: '?', path: fields.join(' ') })
    }
  }
  return { branch, entries }
}

/**
 * 解析 `diff --numstat -z` 输出，key = 目标路径。
 * 记录：`<added>\t<removed>\t<path>\0`；二进制为 `-`（→ null）；
 * 重命名/复制为 `<added>\t<removed>\t\0<origPath>\0<newPath>\0`（实测 git 2.46）。
 */
export function parseNumstat(output: string): Map<string, { added: number | null; removed: number | null }> {
  const counts = new Map<string, { added: number | null; removed: number | null }>()
  const tokens = splitNulRecords(output)
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] as string
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(token)
    if (!match) continue
    const added = match[1] === '-' ? null : Number(match[1])
    const removed = match[2] === '-' ? null : Number(match[2])
    if (match[3] !== '') {
      counts.set(match[3], { added, removed })
      continue
    }
    // 重命名记录：后续两个 token 为 origPath / newPath，行数归属新路径。
    const newPath = tokens[i + 2]
    if (typeof newPath === 'string') {
      counts.set(newPath, { added, removed })
      i += 2
    }
  }
  return counts
}

/** porcelain 状态字母 → 面板变更类型（T 类型变更按 modified，C 复制按 renamed）。 */
export function statusLetterToKind(letter: string): GitPanelChangeKind {
  switch (letter) {
    case 'A': return 'added'
    case 'D': return 'deleted'
    case 'R':
    case 'C': return 'renamed'
    case 'U': return 'conflicted'
    default: return 'modified'
  }
}

/** porcelain v2 未改动侧字母（v2 用 '.'，防御性兼容 v1 的 ' '）。 */
function isUnchangedSide(letter: string): boolean {
  return letter === '.' || letter === ' '
}

/** 状态条目 → 面板变更列表（一条记录可同时产出 staged 与 unstaged 两条）。 */
export function assembleChanges(
  entries: ParsedStatusEntry[],
  worktreeNumstat: Map<string, { added: number | null; removed: number | null }>,
  cachedNumstat: Map<string, { added: number | null; removed: number | null }>,
  repoRoot: string,
  workspacePath: string,
): GitPanelChange[] {
  const changes: GitPanelChange[] = []
  for (const entry of entries) {
    if (entry.x === '?') {
      const repoRelativePath = entry.path
      changes.push({
        path: toWorkspaceRelativePath(repoRoot, workspacePath, repoRelativePath),
        repoRelativePath,
        kind: 'added',
        section: 'untracked',
        added: null,
        removed: null,
      })
      continue
    }
    if (entry.x === 'U' || entry.y === 'U') {
      const repoRelativePath = entry.path
      const counts = worktreeNumstat.get(repoRelativePath)
      changes.push({
        path: toWorkspaceRelativePath(repoRoot, workspacePath, repoRelativePath),
        repoRelativePath,
        kind: 'conflicted',
        section: 'unstaged',
        added: counts?.added ?? null,
        removed: counts?.removed ?? null,
      })
      continue
    }
    const repoRelativePath = entry.path
    const displayPath = toWorkspaceRelativePath(repoRoot, workspacePath, repoRelativePath)
    if (!isUnchangedSide(entry.x) && entry.x !== '?') {
      const counts = cachedNumstat.get(repoRelativePath)
      changes.push({ path: displayPath, repoRelativePath, kind: statusLetterToKind(entry.x), section: 'staged', added: counts?.added ?? null, removed: counts?.removed ?? null })
    }
    if (!isUnchangedSide(entry.y) && entry.y !== '?') {
      const counts = worktreeNumstat.get(repoRelativePath)
      changes.push({ path: displayPath, repoRelativePath, kind: statusLetterToKind(entry.y), section: 'unstaged', added: counts?.added ?? null, removed: counts?.removed ?? null })
    }
  }
  return changes
}

/** 展示路径：工作区是仓库根的子目录时去掉前缀，否则原样返回仓库根相对路径。 */
export function toWorkspaceRelativePath(repoRoot: string, workspacePath: string, repoRelativePath: string): string {
  const rel = path.relative(repoRoot, workspacePath)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return repoRelativePath
  const prefix = rel.split(path.sep).join('/') + '/'
  return repoRelativePath.startsWith(prefix) ? repoRelativePath.slice(prefix.length) : repoRelativePath
}

/* ── 载荷校验（ipc reject 由 lume:invoke envelope 送达 renderer） ──────── */

function parseNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty string`)
  }
  return value
}

const DIFF_SECTIONS: ReadonlySet<string> = new Set(['unstaged', 'staged', 'untracked'])

function parseDiffSection(value: unknown): GitPanelSection {
  if (typeof value !== 'string' || !DIFF_SECTIONS.has(value)) {
    throw new TypeError('section must be one of unstaged/staged/untracked')
  }
  return value as GitPanelSection
}
