// 必须用 node --experimental-vm-modules 运行（bun test 不支持 vm.SourceTextModule，
// 会得到 "vm.SourceTextModule is not a constructor"）：bun run test:node-repl-worker
// 或 desktop 的 test / test:smoke 链（已带正确 flag 与 runner）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
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
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // terminate 未完成时残留句柄可致 EBUSY/EPERM（Windows 常见）；
        // 清理失败不应吞掉 settle 回调让测试悬挂
      }
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
  // 高危模块全拒绝（盲区复审：此前只测 fs，fs/promises 是独立枚举项）
  for (const specifier of [
    'node:fs', 'node:fs/promises', 'node:child_process', 'node:vm',
    'node:http', 'node:worker_threads', 'node:process',
    'child_process', // 裸说明符经 normalize 后同闸门
  ]) {
    const denied = await runCell(`await import(${JSON.stringify(specifier)})`)
    assert.equal(denied.ok, false, `${specifier} must be rejected`)
    assert.match(denied.error, /not allowed in node_repl cells/)
  }

  const allowed = await runCell('const m = await import("node:crypto"); nodeRepl.write(typeof m.createHash)')
  assert.equal(allowed.ok, true)
  assert.match(allowed.output, /function/)

  // 兼容性回归缓解（P1）：无宿主特权的 os/stream/readline 补入白名单，
  // 存量依赖这些模块的 js 单元升级后不再断裂
  for (const specifier of ['node:os', 'node:stream', 'node:readline/promises']) {
    const result = await runCell(`await import(${JSON.stringify(specifier)}); nodeRepl.write('ok')`)
    assert.equal(result.ok, true, `${specifier} should be allowed`)
    assert.match(result.output, /ok/)
  }

  // os 的跨进程原语在 untrusted 加载时被拔除（第三轮对抗复审）：
  // getPriority/setPriority 是免 fs 的进程枚举 oracle 与降速原语
  const stripped = await runCell(
    'const os = await import("node:os"); nodeRepl.write(String(os.getPriority === undefined && os.setPriority === undefined))'
  )
  assert.equal(stripped.ok, true)
  assert.match(stripped.output, /^true$/)

  // 子路径不在显式枚举内：即使本体（util）在白名单，未列出的 subpath 也拒绝
  const subpathDenied = await runCell('await import("node:util/types")')
  assert.equal(subpathDenied.ok, false)
})
