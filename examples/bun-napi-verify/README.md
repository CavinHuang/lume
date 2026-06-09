# Bun + napi-rs 兼容性验证

验证 Lume 日志重构方案中 sidecar（Bun 运行时）通过 napi-rs 调用 Rust 日志核心的可行性。

## 验证矩阵

| # | 验证点 | 命令 | 期望结果 | 状态 |
|---|--------|------|----------|------|
| 1 | Rust napi crate 编译 | `bun run build:macos` | 生成 `.node` 文件 | ✅ |
| 2 | Bun dev 加载 `.node` | `bun run test` | 全部测试通过 (13/13) | ✅ |
| 3 | Bun `--hot` 模式加载 | `bun run test:dev` | 正常运行 | ⬜ |
| 4 | `bun build --compile` | `bun run test:compile` | 编译后可执行 | ✅ |
| 5 | 高频调用性能 | `bun run test:perf` | >100K ops/s | ✅ |
| 6 | 结构化对象传递 | 包含在 test | 字段完整 | ✅ |
| 7 | 错误传播 | 包含在 test | napi Error → TS throw | ✅ |
| 8 | 异步函数 | 包含在 test | Promise 正确 resolve | ✅ |
| 9 | 全局状态 | 包含在 test | Mutex 跨调用正确 | ✅ |

## 快速开始

```bash
cd examples/bun-napi-verify

# 1. 编译 Rust → .node
bun run build:macos

# 2. 运行全部验证
bun run test

# 3. 性能测试
bun run test:perf

# 4. 编译为单文件可执行
bun run test:compile
```

## 关键验证说明

### V1: 编译

napi-rs 需要编译为 `cdylib`，Bun 通过 `dlopen` 加载 `.dylib`（macOS）。

当前方案手动 `cp` 到 `.node` 后缀。如果后续正式接入，应使用 `@napi-rs/cli` 自动生成平台包。

### V4: bun build --compile

**已验证可行，但需要额外处理。**

Bun `--compile` **不会**自动嵌入 `.node` 文件。实测结果：
- `__dirname` 在编译后仍指向源码目录（✅ 可用）
- `import.meta.dir` 在编译后变成 `/$bunfs/root/`（❌ 不可用）
- `.node` 文件必须存在于 `__dirname` 指向的路径

解决方案：`.node` 文件随 sidecar 一起分发，放在与 sidecar 相同的目录。
加载时按 `__dirname`（dev）→ `process.execPath` 同目录（compile 后）顺序搜索。

### V5: 性能

Logger 在 sidecar 中每秒可能产生数百次调用。实测结果（M-series Mac）：

| 场景 | 吞吐量 | 单次耗时 |
|------|--------|----------|
| 纯 napi ping | ~5M ops/s | 0.0002ms |
| emitLog（结构化对象） | ~224K ops/s | 0.004ms |
| emitBatch 1000 条 | ~589K ops/s | 0.002ms |
| TS JSON.stringify（对比） | ~1.7M ops/s | 0.001ms |

结论：napi 调用开销约 0.004ms/call，完全满足日志场景需求。
批量模式可进一步降低到 0.002ms/call。

## 文件说明

```
native/
  Cargo.toml          # napi-rs Rust crate
  build.rs            # napi-build 配置
  src/lib.rs          # 验证用的 napi 函数

index.ts              # TS wrapper，模拟 @lume/native-logger 的 API 形状
test.ts               # 功能验证测试
test-perf.ts          # 性能基准测试
test-compile.ts       # 编译后可执行文件验证
package.json          # 构建脚本
```
