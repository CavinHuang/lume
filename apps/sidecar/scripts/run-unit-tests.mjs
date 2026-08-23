import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const packageRoot = join(import.meta.dir, "..");
const repositoryRoot = join(packageRoot, "..", "..");
const sourceRoot = join(packageRoot, "src");
// F7:逐文件隔离子进程——组合跑时 mock.module 污染同批文件(单文件绿、合跑红),
// 进程边界是唯一彻底的隔离;4 路并行摊平 spawn 开销。
const concurrency = 4;

function collectTests(directory) {
  const tests = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      tests.push(...collectTests(path));
    } else if (entry.name.endsWith(".test.ts")) {
      tests.push(path);
    }
  }
  return tests;
}

// scripts/lib 下的测试曾长期不在收集范围（CI 盲区），一并纳入
const tests = [
  ...collectTests(sourceRoot),
  ...collectTests(join(packageRoot, "scripts", "lib")),
]
  .map((path) => relative(repositoryRoot, path))
  .sort();

let cursor = 0;
const failures = [];

// Bun.spawn 异步 + await proc.exited:4 worker 真并行(spawnSync 会阻塞事件循环,
// worker 池退化为串行——实测串行全量 >15min,并行 4 收进 ~1/4 时长)
async function worker() {
  while (cursor < tests.length) {
    const file = tests[cursor++];
    // 每子进程独立 LUME_CONFIG_DIR:并行 worker 共享 HOME 会锁冲突
    // (planning.sqlite 等共享 SQLite "database is locked"——CI 实证)。
    // 目录放 os.tmpdir():仓库内曾误提交过整批测试残留(含 sqlite 二进制)。
    const proc = Bun.spawn({
      // --preload 注入 RuntimeHostPorts(#289):agent-runtime 不再静态引用
      // 应用层,测试经此拿到真实现;路径相对 repositoryRoot(cwd)。
      cmd: ["bun", "test", "--preload", "./apps/sidecar/scripts/host-ports-test-preload.ts", file],
      cwd: repositoryRoot,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        LUME_CONFIG_DIR: join(
          tmpdir(),
          `.tmp-test-config-${process.pid}-${cursor}`,
        ),
      },
    });
    const [exitCode, stderr, stdout] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
      new Response(proc.stdout).text(),
    ]);
    if (exitCode === 0) continue;
    failures.push(file);
    console.error(`\n===== FAIL ${file} (exit ${exitCode}) =====`);
    console.error(stderr);
    console.error(stdout);
  }
}

await Promise.all(Array.from({ length: Math.min(concurrency, tests.length) }, worker));

if (failures.length > 0) {
  console.error(`\n${failures.length}/${tests.length} test files failed:`);
  for (const file of failures) console.error(`  ${file}`);
  process.exit(1);
}
console.log(`${tests.length} test files passed (isolated per-file subprocesses).`);
