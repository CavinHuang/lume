import { readdirSync } from "node:fs";
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

const tests = collectTests(sourceRoot)
  .map((path) => relative(repositoryRoot, path))
  .sort();

let cursor = 0;
const failures = [];

async function worker() {
  while (cursor < tests.length) {
    const file = tests[cursor++];
    const result = Bun.spawnSync({
      cmd: ["bun", "test", file],
      cwd: repositoryRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode === 0) continue;
    failures.push(file);
    console.error(`\n===== FAIL ${file} (exit ${result.exitCode}) =====`);
    console.error(result.stderr.toString());
    console.error(result.stdout.toString());
  }
}

await Promise.all(Array.from({ length: Math.min(concurrency, tests.length) }, worker));

if (failures.length > 0) {
  console.error(`\n${failures.length}/${tests.length} test files failed:`);
  for (const file of failures) console.error(`  ${file}`);
  process.exit(1);
}
console.log(`${tests.length} test files passed (isolated per-file subprocesses).`);
