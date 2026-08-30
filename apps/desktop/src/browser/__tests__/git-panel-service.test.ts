// git-panel-service 解析测试:porcelain v2(-z 分支头/1/2/u/? 记录)、numstat -z
// (普通/二进制/重命名记录)、状态字母归一、staged/unstaged 装配、环境加固。
// 真实 git 的端到端用例在无 git 环境自动跳过。
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  assembleChanges,
  getGitPanelStatus,
  hardenedGitEnv,
  parseGitStatus,
  parseNumstat,
  statusLetterToKind,
} from '../git-panel-service'

const NUL = '\0'

/** 用 NUL/空格拼 porcelain v2 -z 原始输出。 */
function porcelain(lines: string[]): string {
  return lines.join(NUL) + NUL
}

describe('parseGitStatus 分支头', () => {
  test('解析 branch.head 与 branch.ab', () => {
    const parsed = parseGitStatus(porcelain([
      '# branch.oid abc123',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +2 -3',
    ]))
    expect(parsed.branch).toEqual({ branchName: 'main', ahead: 2, behind: 3 })
    expect(parsed.entries).toEqual([])
  })

  test('detached HEAD 分支名为 null；无 upstream 时 ahead/behind 为 0', () => {
    const parsed = parseGitStatus(porcelain(['# branch.oid abc123', '# branch.head (detached)']))
    expect(parsed.branch).toEqual({ branchName: null, ahead: 0, behind: 0 })
  })

  test('忽略其它 # 头与空输出', () => {
    expect(parseGitStatus('').entries).toEqual([])
    const parsed = parseGitStatus(porcelain(['# branch.oid abc123', '# stash 1']))
    expect(parsed.branch.branchName).toBeNull()
    expect(parsed.entries).toEqual([])
  })
})

describe('parseGitStatus 变更记录', () => {
  const HASHES = '100644 100644 100644 hHHH hIII'

  test('type 1：staged-only（X 位状态）', () => {
    const parsed = parseGitStatus(porcelain([`1 M. N... ${HASHES} d/new.txt`]))
    expect(parsed.entries).toEqual([{ x: 'M', y: '.', path: 'd/new.txt' }])
  })

  test('type 1：unstaged-only（Y 位状态）', () => {
    const parsed = parseGitStatus(porcelain([`1 .D N... ${HASHES} gone.txt`]))
    expect(parsed.entries).toEqual([{ x: '.', y: 'D', path: 'gone.txt' }])
  })

  test('type 1：两边都有状态（MM）', () => {
    const parsed = parseGitStatus(porcelain([`1 MM N... ${HASHES} both.txt`]))
    expect(parsed.entries).toEqual([{ x: 'M', y: 'M', path: 'both.txt' }])
  })

  test('type 2：重命名消费额外 origPath token，后续记录不错位', () => {
    const parsed = parseGitStatus(porcelain([
      `2 R. N... ${HASHES} R66 renamed.txt`,
      'old.txt',
      `1 .M N... ${HASHES} d/after.txt`,
    ]))
    expect(parsed.entries).toEqual([
      { x: 'R', y: '.', path: 'renamed.txt', origPath: 'old.txt' },
      { x: '.', y: 'M', path: 'd/after.txt' },
    ])
  })

  test('type u：未合并记录归一为 U/U', () => {
    const parsed = parseGitStatus(porcelain([`u UU N... 100644 100644 100644 100644 h1 h2 h3 conflict.txt`]))
    expect(parsed.entries).toEqual([{ x: 'U', y: 'U', path: 'conflict.txt' }])
  })

  test('type ?：untracked；路径含空格不丢字段', () => {
    const parsed = parseGitStatus(porcelain(['? dir with space/u.txt', '? plain.txt']))
    expect(parsed.entries).toEqual([
      { x: '?', y: '?', path: 'dir with space/u.txt' },
      { x: '?', y: '?', path: 'plain.txt' },
    ])
  })

  test('type 1 路径含空格保持完整', () => {
    const parsed = parseGitStatus(porcelain([`1 .M N... ${HASHES} my file.txt`]))
    expect(parsed.entries[0]!.path).toBe('my file.txt')
  })
})

describe('parseNumstat', () => {
  test('普通记录', () => {
    const counts = parseNumstat(`12\t3\ta/b.txt${NUL}`)
    expect(counts.get('a/b.txt')).toEqual({ added: 12, removed: 3 })
  })

  test('二进制记录（- -）映射为 null', () => {
    const counts = parseNumstat(`-\t-\timg.png${NUL}`)
    expect(counts.get('img.png')).toEqual({ added: null, removed: null })
  })

  test('重命名记录：行数归属新路径（实测 git 2.46 格式 added\\tremoved\\t\\0old\\0new\\0）', () => {
    const counts = parseNumstat(`1\t1\t${NUL}old.txt${NUL}renamed.txt${NUL}`)
    expect(counts.get('renamed.txt')).toEqual({ added: 1, removed: 1 })
    expect(counts.has('old.txt')).toBe(false)
  })

  test('多条记录混合', () => {
    const counts = parseNumstat(`5\t0\ta.txt${NUL}-\t-\tb.bin${NUL}2\t2\t${NUL}o.txt${NUL}n.txt${NUL}`)
    expect(counts.get('a.txt')).toEqual({ added: 5, removed: 0 })
    expect(counts.get('b.bin')).toEqual({ added: null, removed: null })
    expect(counts.get('n.txt')).toEqual({ added: 2, removed: 2 })
  })

  test('空输出', () => {
    expect(parseNumstat('').size).toBe(0)
  })
})

describe('statusLetterToKind', () => {
  test('字母归一（T 按 modified，C 按 renamed）', () => {
    expect(statusLetterToKind('A')).toBe('added')
    expect(statusLetterToKind('D')).toBe('deleted')
    expect(statusLetterToKind('M')).toBe('modified')
    expect(statusLetterToKind('T')).toBe('modified')
    expect(statusLetterToKind('R')).toBe('renamed')
    expect(statusLetterToKind('C')).toBe('renamed')
    expect(statusLetterToKind('U')).toBe('conflicted')
  })
})

describe('assembleChanges', () => {
  const worktree = new Map([['w.txt', { added: 1, removed: 2 }]])
  const cached = new Map([['s.txt', { added: 3, removed: 0 }]])

  test('同一文件两边都有状态产出两条，行数来自对应 numstat', () => {
    const changes = assembleChanges([{ x: 'M', y: 'M', path: 'both.txt' }], worktree, cached, '/repo', '/repo')
    expect(changes).toEqual([
      { path: 'both.txt', repoRelativePath: 'both.txt', kind: 'modified', section: 'staged', added: null, removed: null },
      { path: 'both.txt', repoRelativePath: 'both.txt', kind: 'modified', section: 'unstaged', added: null, removed: null },
    ])
  })

  test('staged/unstaged 行数按 section 取对应 numstat', () => {
    const changes = assembleChanges(
      [{ x: 'M', y: '.', path: 's.txt' }, { x: '.', y: 'M', path: 'w.txt' }],
      worktree, cached, '/repo', '/repo',
    )
    expect(changes.map((change) => [change.section, change.added, change.removed])).toEqual([
      ['staged', 3, 0],
      ['unstaged', 1, 2],
    ])
  })

  test('untracked → untracked 区 + added + 行数 null', () => {
    const changes = assembleChanges([{ x: '?', y: '?', path: 'u.txt' }], worktree, cached, '/repo', '/repo')
    expect(changes).toEqual([
      { path: 'u.txt', repoRelativePath: 'u.txt', kind: 'added', section: 'untracked', added: null, removed: null },
    ])
  })

  test('未合并 → unstaged 区 + conflicted', () => {
    const changes = assembleChanges([{ x: 'U', y: 'U', path: 'c.txt' }], worktree, cached, '/repo', '/repo')
    expect(changes).toEqual([
      { path: 'c.txt', repoRelativePath: 'c.txt', kind: 'conflicted', section: 'unstaged', added: null, removed: null },
    ])
  })

  test('工作区为仓库子目录时展示路径去掉前缀', () => {
    const repoRoot = path.resolve('/repo')
    const workspace = path.join(repoRoot, 'sub')
    const changes = assembleChanges(
      [{ x: '.', y: 'M', path: 'sub/inner.txt' }, { x: '.', y: 'D', path: 'outside-after-sub/other.txt' }],
      new Map(), new Map(), repoRoot, workspace,
    )
    expect(changes[0]!.path).toBe('inner.txt')
    expect(changes[0]!.repoRelativePath).toBe('sub/inner.txt')
    expect(changes[1]!.path).toBe('outside-after-sub/other.txt')
  })
})

describe('hardenedGitEnv', () => {
  test('剥离仓库定位变量并固定输出环境', () => {
    const env = hardenedGitEnv({
      GIT_DIR: '/evil/.git',
      GIT_INDEX_FILE: '/evil/index',
      GIT_CONFIG: '/evil/config',
      GIT_WORK_TREE: '/evil',
      HOME: '/home/u',
    })
    expect(env.GIT_DIR).toBeUndefined()
    expect(env.GIT_INDEX_FILE).toBeUndefined()
    expect(env.GIT_CONFIG).toBeUndefined()
    expect(env.GIT_WORK_TREE).toBeUndefined()
    expect(env.GIT_PAGER).toBe('cat')
    expect(env.LC_ALL).toBe('C')
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
    expect(env.HOME).toBe('/home/u')
  })
})

describe('getGitPanelStatus（真实 git，无 git 环境跳过）', () => {
  const hasGit = spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0
  const git = (args: string[], cwd: string) => {
    spawnSync('git', args, { cwd, stdio: 'ignore', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
  }

  test('临时仓库端到端：分支头 + 三类变更 + 行数', async () => {
    if (!hasGit) return
    const repo = mkdtempSync(path.join(tmpdir(), 'lume-git-panel-'))
    try {
      git(['init', '-q', '-b', 'master', '.'], repo)
      git(['config', 'user.email', 't@t'], repo)
      git(['config', 'user.name', 't'], repo)
      // Windows 全局 autocrlf 会把「LF 文件 + add」误报为 worktree 再修改，仓库内关闭。
      git(['config', 'core.autocrlf', 'false'], repo)
      writeFileSync(path.join(repo, 'base.txt'), 'a\n')
      git(['add', '.'], repo)
      git(['commit', '-qm', 'init'], repo)

      writeFileSync(path.join(repo, 'modified.txt'), 'x\n')
      git(['add', 'modified.txt'], repo)
      writeFileSync(path.join(repo, 'modified.txt'), 'x2\n') // staged 后再改出 unstaged
      writeFileSync(path.join(repo, 'staged-only.txt'), 's\n')
      git(['add', 'staged-only.txt'], repo)
      writeFileSync(path.join(repo, 'untracked.txt'), 'u\n')

      const status = await getGitPanelStatus(repo)
      expect(status.isGitAvailable).toBe(true)
      expect(status.isRepository).toBe(true)
      expect(status.branchName).toBe('master')
      expect(status.isDirty).toBe(true)

      const staged = status.changes.filter((change) => change.section === 'staged')
      const unstaged = status.changes.filter((change) => change.section === 'unstaged')
      const untracked = status.changes.filter((change) => change.section === 'untracked')
      expect(staged.map((change) => change.path).sort()).toEqual(['modified.txt', 'staged-only.txt'])
      expect(unstaged.map((change) => change.path)).toEqual(['modified.txt'])
      expect(untracked.map((change) => change.path)).toEqual(['untracked.txt'])

      const stagedModified = staged.find((change) => change.path === 'modified.txt')!
      expect(stagedModified.added).toBe(1)
      expect(stagedModified.removed).toBe(0)
      const unstagedModified = unstaged[0]!
      expect(unstagedModified.added).toBe(1)
      expect(unstagedModified.removed).toBe(1)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('非 git 目录返回 isRepository=false', async () => {
    if (!hasGit) return
    const dir = mkdtempSync(path.join(tmpdir(), 'lume-git-norepo-'))
    try {
      const status = await getGitPanelStatus(dir)
      expect(status.isGitAvailable).toBe(true)
      expect(status.isRepository).toBe(false)
      expect(status.changes).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
