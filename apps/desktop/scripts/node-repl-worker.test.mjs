import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'

const WORKER_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'resources-src',
  'node-repl',
  'runtime',
  'worker.js',
)

// 真实 Worker 起打包资源 worker.js，经消息协议执行一个 cell 并收集结果。
// #545 的 builtin import gate 是五项核心修复中唯一没有行为测试的——manifest
// 哈希校验只钉 manifest↔文件一致，改 worker 逻辑并同步哈希即可静默绕过 CI。
function runCell(code) {
  return new Promise((resolvePromise, rejectPromise) => {
    const dir = mkdtempSync(join(tmpdir(), 'lume-node-repl-worker-'))
    let settled = false
    const finish = (fn) => {
      if (settled) return
      settled = true
      clearTimeout(guard)
      worker.terminate()
      rmSync(dir, { recursive: true, force: true })
      fn()
    }
    const worker = new Worker(WORKER_PATH, {
      workerData: {
        cwd: dir,
        sessionId: 'contract-test',
        manifest: { name: 'test', permissions: [], allowedEnv: [] },
        env: {},
      },
    })
    const guard = setTimeout(() => finish(() => rejectPromise(new Error('worker timed out'))), 30_000)
    worker.on('message', (message) => {
      if (message.type === 'ready') {
        worker.postMessage({ type: 'exec', id: 'cell-1', code })
        return
      }
      if (message.type === 'execution-result' && message.id === 'cell-1') {
        finish(() => resolvePromise(message))
      }
    })
    worker.on('error', (error) => finish(() => rejectPromise(error)))
    worker.on('exit', (code) => finish(() => rejectPromise(new Error(`worker exited before result (code=${code})`))))
  })
}

test('builtin import gate rejects host-privileged builtins and allows the pure-computation allowlist (#545)', async () => {
  const denied = await runCell('await import("node:fs")')
  assert.equal(denied.ok, false)
  assert.match(denied.error, /not allowed in node_repl cells/)
  assert.match(denied.error, /Allowed builtin modules:/)

  const allowed = await runCell('const m = await import("node:crypto"); nodeRepl.write(typeof m.createHash)')
  assert.equal(allowed.ok, true)
  assert.match(allowed.output, /function/)

  // 子路径不在显式枚举内：即使本体（util）在白名单，未列出的 subpath 也拒绝
  const subpathDenied = await runCell('await import("node:util/types")')
  assert.equal(subpathDenied.ok, false)
})

// #634：trusted 集覆盖工作目录会让 cell 虚拟 referrer（cwd 下 .node_repl_cell_*.mjs）
// 整体落入 trusted 判定，使 builtin 白名单失效。kernel-process 必须剔除并告警。
test('kernel-process drops trusted-code-path entries that cover the working directory (#634)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lume-node-repl-kernel-'))
  const child = spawn(process.execPath, [
    resolve(dirname(fileURLToPath(import.meta.url)), '..', 'resources-src', 'node-repl', 'runtime', 'kernel-process.js'),
    '--session-id', 'kernel-trust-test',
    '--working-dir', dir,
  ], {
    // 敌意形态同时覆盖两条归一路径：尾部 separator（根条目 resolve 后保留，
    // 否则 startsWith 双分隔符恒假漏判）与 Windows 大小写不敏感
    env: {
      ...process.env,
      NODE_REPL_TRUSTED_CODE_PATHS: process.platform === 'win32' ? `${dir.toUpperCase()}\\` : `${dir}/`,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stderr = ''
  let stdout = ''
  child.stderr.on('data', (chunk) => { stderr += String(chunk) })
  child.stdout.on('data', (chunk) => { stdout += String(chunk) })
  try {
    await new Promise((resolvePromise, rejectPromise) => {
      const guard = setTimeout(() => {
        child.kill()
        rejectPromise(new Error(`kernel-process did not become ready; stdout=${stdout.slice(0, 400)}`))
      }, 30_000)
      const poll = setInterval(() => {
        if (stdout.includes('privileged_bridge_handshake')) {
          clearTimeout(guard)
          clearInterval(poll)
          resolvePromise()
        }
      }, 50)
    })
  } finally {
    if (child.exitCode === null) {
      child.kill()
      // Windows：进程未退出前目录句柄仍被占用，rmSync 会 EPERM
      await new Promise((resolvePromise) => child.once('exit', resolvePromise))
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  }
  assert.match(stderr, /dropping NODE_REPL_TRUSTED_CODE_PATHS entry/)
})
