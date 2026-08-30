// 必须用 node --experimental-vm-modules 运行（bun test 不支持 vm.SourceTextModule，
// 会得到 "vm.SourceTextModule is not a constructor"）：bun run test:node-repl-worker
// 或 desktop 的 test / test:smoke 链（已带正确 flag 与 runner）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
function runCell(code, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const dir = mkdtempSync(join(tmpdir(), 'lume-node-repl-worker-'))
    options.setup?.(dir)
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
        options.beforeExec?.(worker, dir)
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

// ─── #796 untrusted realm 加固三切片的行为钉（真进程）───

test('untrusted realm hardening: Buffer facade and captured console deny realm-escape primitives (#796)', async () => {
  const result = await runCell(`
    const probes = {
      bufferConstructor: typeof Buffer.constructor,
      bufferPrototype: String(Object.getPrototypeOf(Buffer)),
      bufferFrozen: Object.isFrozen(Buffer),
      bufferAllocWorks: Buffer.from('ok').toString(),
      consolePrototype: String(Object.getPrototypeOf(console)),
      consoleTableRouted: typeof console.table,
    };
    nodeRepl.write(JSON.stringify(probes))
  `)
  assert.equal(result.ok, true)
  const probes = JSON.parse(result.output)
  // 全局 Buffer 标识符的 null 原型冻结门面：宿主 Function 不可达（探针失效）
  assert.equal(probes.bufferConstructor, 'undefined')
  assert.equal(probes.bufferPrototype, 'null')
  assert.equal(probes.bufferFrozen, true)
  assert.equal(probes.bufferAllocWorks, 'ok')
  // 捕获 console 为 null 原型冻结对象——{...console} 展开会拷入宿主真方法
  // 引用（table/dir/... 的 .constructor 即宿主 Function，同级逃逸）
  assert.equal(probes.consolePrototype, 'null')
  assert.equal(probes.consoleTableRouted, 'function')
})

test('bare package imports no longer resolve from cwd by default; the failure names the approval tool (#796)', async () => {
  const result = await runCell('await import("mini-pkg")', {
    setup(dir) {
      mkdirSync(join(dir, 'node_modules', 'mini-pkg'), { recursive: true })
      writeFileSync(join(dir, 'node_modules', 'mini-pkg', 'package.json'), JSON.stringify({ name: 'mini-pkg', version: '1.0.0', main: 'index.js' }))
      writeFileSync(join(dir, 'node_modules', 'mini-pkg', 'index.js'), 'export const stamp = "mini-pkg-ok"\n')
    },
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /js_add_node_module_dir/)
})

test('registering the project node_modules dir via add-module-dir restores bare imports (#796)', async () => {
  const result = await runCell('const mod = await import("mini-pkg"); nodeRepl.write(mod.stamp)', {
    setup(dir) {
      mkdirSync(join(dir, 'node_modules', 'mini-pkg'), { recursive: true })
      writeFileSync(join(dir, 'node_modules', 'mini-pkg', 'package.json'), JSON.stringify({ name: 'mini-pkg', version: '1.0.0', main: 'index.js' }))
      writeFileSync(join(dir, 'node_modules', 'mini-pkg', 'index.js'), 'export const stamp = "mini-pkg-ok"\n')
    },
    // 审批面模拟：js_add_node_module_dir（high 审批）在协议层即 add-module-dir
    beforeExec(worker, dir) {
      worker.postMessage({ type: 'add-module-dir', path: join(dir, 'node_modules') })
    },
  })
  assert.equal(result.ok, true)
  assert.match(result.output, /mini-pkg-ok/)
})
