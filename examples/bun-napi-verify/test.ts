/**
 * Bun + napi-rs 兼容性验证测试
 *
 * 运行方式：
 *   bun run build:macos   # 先编译 native
 *   bun run test          # 运行验证
 */

import {
  hello,
  emitLog,
  initLogger,
  asyncWriteLog,
  ping,
  emitBatch,
  setupGlobalLogger,
  getLogDir,
  type LogInput,
} from "./index";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.error(`  ❌ ${label}`);
    failed++;
  }
}

async function assertAsync(
  promise: Promise<unknown>,
  label: string,
) {
  try {
    await promise;
    console.log(`  ✅ ${label}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ ${label} —`, err);
    failed++;
  }
}

// ── 1. 基础函数 ──────────────────────────────────────────

console.log("\n━━ 1. 基础函数调用 ━━");

assert(typeof hello === "function", "hello is a function");

const greeting = hello();
assert(typeof greeting === "string", `hello() returns string: "${greeting}"`);
assert(greeting === "hello from napi", "hello() returns correct value");

// ── 2. 结构化对象入参 ────────────────────────────────────

console.log("\n━━ 2. 结构化对象入参 ━━");

const logResult = emitLog({
  level: "info",
  source: "sidecar",
  context: "sidecar.boot",
  message: "sidecar started",
  data: JSON.stringify({ pid: 1234 }),
} satisfies LogInput);

assert(logResult.written === true, "emitLog returns written=true");
assert(typeof logResult.bytes === "number", `emitLog returns bytes=${logResult.bytes}`);
assert(logResult.bytes > 0, "emitLog bytes > 0");

// ── 3. Result 返回（成功 / 错误）──────────────────────────
// napi 同步函数返回 Result<()> 时：Ok → undefined, Err → 直接 throw

console.log("\n━━ 3. Result 返回 ━━");

try {
  initLogger("/tmp/lume-logs");
  assert(true, "initLogger with valid path succeeds");
} catch (err) {
  assert(false, `initLogger with valid path threw: ${err}`);
}

try {
  initLogger("");
  assert(false, "initLogger with empty string should have thrown");
} catch (err: any) {
  assert(
    String(err).includes("config_dir cannot be empty"),
    "initLogger with empty string throws correct error",
  );
}

// ── 4. 异步函数 ─────────────────────────────────────────

console.log("\n━━ 4. 异步函数 ━━");

await assertAsync(
  asyncWriteLog("test message").then((result: string) => {
    if (!result.includes("written: test message")) {
      throw new Error(`unexpected result: ${result}`);
    }
  }),
  "asyncWriteLog resolves with correct value",
);

// ── 5. 高频调用 ─────────────────────────────────────────

console.log("\n━━ 5. 高频调用 ━━");

const ITERATIONS = 10_000;
const start = performance.now();
for (let i = 0; i < ITERATIONS; i++) {
  ping();
}
const elapsed = performance.now() - start;
const opsPerSec = Math.round(ITERATIONS / (elapsed / 1000));

assert(
  opsPerSec > 100_000,
  `${ITERATIONS} sync ping calls in ${elapsed.toFixed(1)}ms (${opsPerSec} ops/s)`,
);

// ── 6. 批量写入 ─────────────────────────────────────────

console.log("\n━━ 6. 批量写入 ━━");

const batchInputs: LogInput[] = Array.from({ length: 1000 }, (_, i) => ({
  level: "debug",
  source: "sidecar",
  context: "sidecar.agent.tool",
  message: `tool call ${i}`,
  data: JSON.stringify({ index: i, tool: "read_file" }),
}));

const batchStart = performance.now();
const batchCount = emitBatch(batchInputs);
const batchElapsed = performance.now() - batchStart;

assert(
  batchCount === 1000,
  `emitBatch(1000) returned ${batchCount} in ${batchElapsed.toFixed(1)}ms`,
);

// ── 7. 全局状态 ─────────────────────────────────────────
// 同步函数，不用 await

console.log("\n━━ 7. 全局状态 ━━");

try {
  setupGlobalLogger("/var/log/lume");
  assert(true, "setupGlobalLogger succeeds");
} catch (err) {
  assert(false, `setupGlobalLogger threw: ${err}`);
}

try {
  const dir = getLogDir();
  assert(
    dir === "/var/log/lume",
    `getLogDir returns previously set value: ${dir}`,
  );
} catch (err) {
  assert(false, `getLogDir threw: ${err}`);
}

// ── 总结 ────────────────────────────────────────────────

console.log(`\n${"═".repeat(50)}`);
console.log(`结果: ${passed} passed, ${failed} failed`);
console.log(`${"═".repeat(50)}\n`);

if (failed > 0) {
  process.exit(1);
}
