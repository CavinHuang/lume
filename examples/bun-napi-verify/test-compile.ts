/**
 * bun build --compile 兼容性验证
 *
 * 验证编译后的单文件可执行程序能否通过以下方式加载 .node：
 *   方式 A: __dirname（bun dev 模式）
 *   方式 B: process.execPath 同目录（bun compile 后）
 *   方式 C: require.resolve + 动态路径
 */

import path from "path";

let native: any;
let loadMethod = "";

const candidates = [
  "./lume-native-logger-verify.darwin-arm64.node",
  "./lume-native-logger-verify.darwin-x64.node",
  "./lume-native-logger-verify.linux-x64-gnu.node",
  "./lume-native-logger-verify.win32-x64-msvc.node",
];

// ── 方式 A: __dirname（bun dev 正常场景）─────────────────────

for (const candidate of candidates) {
  try {
    const resolved = path.resolve(__dirname, candidate);
    native = require(resolved);
    loadMethod = `__dirname → ${resolved}`;
    break;
  } catch {}
}

// ── 方式 B: process.execPath 同目录（bun compile 后场景）──────

if (!native) {
  // process.execPath 在 compile 后是可执行文件自身路径
  const exeDir = path.dirname(process.execPath);
  for (const candidate of candidates) {
    try {
      const resolved = path.resolve(exeDir, candidate);
      native = require(resolved);
      loadMethod = `execPath → ${resolved}`;
      break;
    } catch {}
  }
}

// ── 方式 C: import.meta.dir（Bun 特有）──────────────────────

if (!native) {
  for (const candidate of candidates) {
    try {
      // Bun 支持 import.meta.dir
      const resolved = path.resolve((import.meta as any).dir, candidate);
      native = require(resolved);
      loadMethod = `import.meta.dir → ${resolved}`;
      break;
    } catch {}
  }
}

// ── 结果 ────────────────────────────────────────────────

console.log("══ bun build --compile 验证 ══");
console.log();
console.log(`process.execPath: ${process.execPath}`);
console.log(`__dirname: ${__dirname}`);
console.log(`import.meta.dir: ${(import.meta as any).dir}`);
console.log();

if (!native) {
  console.log("❌ 所有加载方式均失败");
  console.log();
  console.log("诊断信息：");
  console.log("  - bun compile 不自动嵌入 .node 文件");
  console.log("  - 需要 .node 文件与可执行文件在同一目录");
  console.log("  - 或使用 runtime 动态路径加载");
  process.exit(1);
}

console.log(`加载方式: ${loadMethod}`);
console.log();

const { hello, emitLog } = native;

const greeting = hello();
console.log(`hello(): ${greeting}`);

const result = emitLog({
  level: "info",
  source: "sidecar",
  context: "compile-test",
  message: "compiled binary can call native module",
  data: undefined,
});

console.log(`emitLog: written=${result.written}, bytes=${result.bytes}`);
console.log();

if (greeting === "hello from napi" && result.written) {
  console.log("✅ 编译后可执行文件可以正确加载 native 模块");
  process.exit(0);
} else {
  console.log("❌ native 模块调用结果不正确");
  process.exit(1);
}
