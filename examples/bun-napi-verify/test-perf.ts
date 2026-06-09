/**
 * 性能测试：模拟 logger 高频写入场景
 *
 * 运行方式：
 *   bun run test-perf
 */

import { emitLog, emitBatch, ping, type LogInput } from "./index";

function formatNumber(n: number): string {
  return n.toLocaleString();
}

// ── 1. 单条写入吞吐 ─────────────────────────────────────

console.log("\n━━ 1. 单条 emitLog 吞吐 ━━");

const SINGLE_ITERATIONS = 50_000;

const singleStart = performance.now();
for (let i = 0; i < SINGLE_ITERATIONS; i++) {
  emitLog({
    level: i % 2 === 0 ? "debug" : "info",
    source: "sidecar",
    context: "sidecar.agent.tool",
    message: `log entry ${i}`,
    data: JSON.stringify({ index: i }),
  });
}
const singleElapsed = performance.now() - singleStart;
const singleOps = Math.round(SINGLE_ITERATIONS / (singleElapsed / 1000));

console.log(
  `  ${formatNumber(SINGLE_ITERATIONS)} calls in ${singleElapsed.toFixed(1)}ms`,
);
console.log(`  ${formatNumber(singleOps)} ops/s`);
console.log(
  `  ${(singleElapsed / SINGLE_ITERATIONS).toFixed(3)}ms per call`,
);

// ── 2. 批量写入吞吐 ─────────────────────────────────────

console.log("\n━━ 2. 批量 emitBatch 吞吐 ━━");

const BATCH_SIZE = 1000;
const BATCH_ROUNDS = 50;

const batchInputs: LogInput[] = Array.from({ length: BATCH_SIZE }, (_, i) => ({
  level: "debug",
  source: "sidecar",
  context: "sidecar.agent.tool",
  message: `batch log ${i}`,
  data: JSON.stringify({ index: i }),
}));

const batchStart = performance.now();
for (let r = 0; r < BATCH_ROUNDS; r++) {
  emitBatch(batchInputs);
}
const batchElapsed = performance.now() - batchStart;
const batchTotal = BATCH_SIZE * BATCH_ROUNDS;
const batchOps = Math.round(batchTotal / (batchElapsed / 1000));

console.log(
  `  ${formatNumber(batchTotal)} logs (${BATCH_ROUNDS} × ${BATCH_SIZE}) in ${batchElapsed.toFixed(1)}ms`,
);
console.log(`  ${formatNumber(batchOps)} ops/s`);
console.log(
  `  ${(batchElapsed / batchTotal).toFixed(3)}ms per log`,
);

// ── 3. 纯 napi 调用开销 ─────────────────────────────────

console.log("\n━━ 3. 纯 napi ping 开销 ━━");

const PING_ITERATIONS = 100_000;
const pingStart = performance.now();
for (let i = 0; i < PING_ITERATIONS; i++) {
  ping();
}
const pingElapsed = performance.now() - pingStart;

console.log(
  `  ${formatNumber(PING_ITERATIONS)} pings in ${pingElapsed.toFixed(1)}ms`,
);
console.log(
  `  ${(pingElapsed / PING_ITERATIONS).toFixed(4)}ms per ping (${Math.round(PING_ITERATIONS / (pingElapsed / 1000))} ops/s)`,
);

// ── 4. 对比：纯 JSON.stringify TS 侧开销 ──────────────────

console.log("\n━━ 4. 对比：TS 侧 JSON.stringify ━━");

const TS_ITERATIONS = 50_000;
const tsStart = performance.now();
for (let i = 0; i < TS_ITERATIONS; i++) {
  JSON.stringify({
    level: "debug",
    source: "sidecar",
    context: "sidecar.agent.tool",
    message: `log entry ${i}`,
    data: { index: i },
  });
}
const tsElapsed = performance.now() - tsStart;
const tsOps = Math.round(TS_ITERATIONS / (tsElapsed / 1000));

console.log(
  `  ${formatNumber(TS_ITERATIONS)} stringify in ${tsElapsed.toFixed(1)}ms`,
);
console.log(`  ${formatNumber(tsOps)} ops/s`);
console.log(
  `  ${(tsElapsed / TS_ITERATIONS).toFixed(3)}ms per call`,
);

// ── 总结 ────────────────────────────────────────────────

console.log("\n━━ 总结 ━━");
console.log(
  `  napi emitLog:  ${formatNumber(singleOps)} ops/s (${(singleElapsed / SINGLE_ITERATIONS).toFixed(3)}ms/call)`,
);
console.log(
  `  napi emitBatch: ${formatNumber(batchOps)} ops/s (${(batchElapsed / batchTotal).toFixed(3)}ms/call)`,
);
console.log(
  `  TS JSON.stringify: ${formatNumber(tsOps)} ops/s (${(tsElapsed / TS_ITERATIONS).toFixed(3)}ms/call)`,
);

const ratio = (singleOps / tsOps).toFixed(2);
console.log(`  napi/TS ratio: ${ratio}x`);
console.log();
