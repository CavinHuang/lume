# Native Rust Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 oh-my-pi (omp) 的高性能 Rust 原生模块（tokens、grep、glob、fd、summarize、ast）移植到 Lume 项目，替换现有 TS 层的外部命令调用，实现进程内零 fork 执行。

**Architecture:** 新建 `lume-natives` crate（N-API cdylib），从 omp 的 `pi-natives` 移植 tokens/grep/glob/fd/fs_cache/task 等模块。新建 `lume-ast` crate 从 omp 的 `pi-ast` 移植 summarize/ast 模块。通过 `@lume/native-logger` 包的扩展（或新建 `@lume/natives` 包）暴露给 sidecar 的 TS 工具层，替换 Grep/Glob 工具的 `spawn('rg')` / `spawn('bash')` 实现。

**Tech Stack:** Rust (N-API, napi-rs v3), tiktoken-rs, grep-regex/grep-searcher, ignore/globset, rayon, tree-sitter, ast-grep-core, TypeScript (Bun sidecar)

**License:** omp 源码为 MIT 协议（© 2025 Mario Zechner, © 2025-2026 Can Bölük）。所有移植文件头部必须保留原始版权声明。

---

## File Structure

```
crates/
  lume-natives/                    ← 新建：核心原生模块
    Cargo.toml
    build.rs
    src/
      lib.rs                       ← 模块声明 + 版本哨兵
      utils.rs                     ← env_uint! 宏 + clamp_u32（从 omp 复制）
      task.rs                      ← CancelToken + Blocking<T> NAPI Task（从 omp 复制）
      tokens.rs                    ← BPE token 计数（从 omp 复制）
      fs_cache.rs                  ← 文件扫描缓存（从 omp 复制）
      glob_util.rs                 ← glob 模式编译（从 omp 复制）
      grep.rs                      ← ripgrep 搜索引擎（从 omp 复制）
      glob.rs                      ← glob 文件发现（从 omp 复制）
      fd.rs                        ← 模糊文件查找（从 omp 复制）

  lume-ast/                        ← 新建：AST/摘要模块
    Cargo.toml
    src/
      lib.rs                       ← 模块声明
      language.rs                  ← 语言支持枚举（从 omp 复制）
      ops.rs                       ← ast-grep 模式匹配（从 omp 复制）
      summary.rs                   ← tree-sitter 结构化摘要（从 omp 复制）

packages/
  natives/                         ← 新建：TS NAPI 桥接包
    package.json
    index.ts                       ← 加载 .node 二进制 + 导出类型化 API
    src/
      tokens.ts                    ← token 计数封装
      grep.ts                      ← grep 封装
      glob.ts                      ← glob 封装
      fd.ts                        ← fd 封装
      summary.ts                   ← 摘要封装
      ast.ts                       ← ast 操作封装

packages/sdk/src/tools/
  grep.ts                          ← 修改：优先调 native grep
  glob.ts                          ← 修改：优先调 native glob
```

---

## Phase 1: 基础设施 + Tokens（验证通道）

### Task 1: 创建 lume-natives crate 骨架

**Files:**
- Create: `crates/lume-natives/Cargo.toml`
- Create: `crates/lume-natives/build.rs`
- Create: `crates/lume-natives/src/lib.rs`
- Create: `crates/lume-natives/src/utils.rs`

- [ ] **Step 1: 创建 Cargo.toml**

```toml
[package]
name = "lume-natives"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]
doctest = false

[dependencies]
napi = { version = "3", features = ["napi9", "error_anyhow"] }
napi-derive = "3"
tiktoken-rs = "0.6"
rayon = "1.10"
serde = { version = "1", features = ["derive"] }
serde_json = "1"

# grep 模块（Phase 2 启用）
# grep-matcher = "0.1"
# grep-regex = "0.1"
# grep-searcher = "0.1"
# globset = "0.4"
# ignore = "0.4"
# dashmap = "6"
# memmap2 = "0.9"
# smallvec = "1"

[build-dependencies]
napi-build = "2"

[profile.release]
lto = true
strip = true
```

- [ ] **Step 2: 创建 build.rs**

```rust
extern crate napi_build;

fn main() {
    napi_build::setup();
}
```

- [ ] **Step 3: 创建 src/lib.rs**

```rust
//! Lume native performance primitives.
//!
//! N-API bindings for token counting, file search, glob, and more.
//! Sourced from oh-my-pi (pi-natives) with adaptations.
//!
//! License: MIT — © 2025 Mario Zechner, © 2025-2026 Can Bölük

pub mod tokens;
pub mod utils;

// Phase 2 模块（取消注释以启用）
// pub mod task;
// pub mod fs_cache;
// pub mod glob_util;
// pub mod grep;
// pub mod glob;
// pub mod fd;
```

- [ ] **Step 4: 创建 src/utils.rs（从 omp pi-natives/src/utils.rs 复制）**

```rust
//! Utility macros and functions.
//! Adapted from oh-my-pi pi-natives/src/utils.rs
//! License: MIT — © 2025 Mario Zechner, © 2025-2026 Can Bölük

/// Read a compile-time env var as u32, with optional clamp range.
///
/// ```
/// // CACHE_TTL_MS env var, default 5000, clamped to 100..=60000
/// env_uint!(CACHE_TTL_MS, 5000, 100..=60000);
/// ```
#[macro_export]
macro_rules! env_uint {
    ($name:ident, $default:expr) => {
        static $name: u32 = {
            let val = option_env!(stringify!($name))
                .and_then(|s| s.parse::<u32>().ok())
                .unwrap_or($default);
            val
        };
    };
    ($name:ident, $default:expr, $min:expr..=$max:expr) => {
        static $name: u32 = {
            let val = option_env!(stringify!($name))
                .and_then(|s| s.parse::<u32>().ok())
                .unwrap_or($default);
            let clamped = val.clamp($min, $max);
            clamped
        };
    };
}

/// Saturating cast u64 → u32.
#[inline]
pub fn clamp_u32(v: u64) -> u32 {
    if v > u32::MAX as u64 {
        u32::MAX
    } else {
        v as u32
    }
}
```

- [ ] **Step 5: 验证编译**

Run: `cd crates/lume-natives && cargo check`
Expected: 编译通过，无错误

- [ ] **Step 6: 提交**

```bash
git add crates/lume-natives/
git commit -m "feat(natives): scaffold lume-natives crate with utils module"
```

---

### Task 2: 移植 tokens 模块

**Files:**
- Create: `crates/lume-natives/src/tokens.rs`
- Reference: omp `pi-natives/src/tokens.rs`（66 行，零内部依赖）

- [ ] **Step 1: 创建 src/tokens.rs（从 omp 复制并适配）**

omp 原始代码只有 66 行，核心是：
- 两种编码器 `O200kBase`（GPT-4o）、`Cl100kBase`（GPT-3.5/4）
- `count_tokens(text, encoding)` → `u32`
- 支持单个字符串或字符串数组（并行 rayon）

```rust
//! BPE token counting via tiktoken-rs.
//! Adapted from oh-my-pi pi-natives/src/tokens.rs
//! License: MIT — © 2025 Mario Zechner, © 2025-2026 Can Bölük

use napi::bindgen_prelude::*;
use napi_derive::napi;
use rayon::prelude::*;
use tiktoken_rs::{Cl100kBase, O200kBase, get_tokenizer};

#[napi(object)]
pub struct TokenCountInput {
    pub text: Either<String, Vec<String>>,
    pub model: Option<String>,
}

#[napi(object)]
pub struct TokenCountResult {
    pub count: f64,
}

/// Count BPE tokens for text. Uses O200kBase (GPT-4o) by default,
/// or Cl100kBase for older models.
#[napi]
pub fn count_tokens(input: TokenCountInput) -> Result<TokenCountResult> {
    let encoding = match input.model.as_deref() {
        Some(m) if m.contains("gpt-3.5") || m.contains("gpt-4-") => "cl100k_base",
        _ => "o200k_base",
    };

    let count = match input.text {
        Either::A(text) => count_single(&text, encoding),
        Either::B(texts) => texts.par_iter().map(|t| count_single(t, encoding)).sum(),
    };

    Ok(TokenCountResult {
        count: count as f64,
    })
}

fn count_single(text: &str, encoding: &str) -> usize {
    match encoding {
        "cl100k_base" => Cl100kBase::new()
            .map(|t| t.encode_with_ordinary(text).len())
            .unwrap_or(0),
        _ => O200kBase::new()
            .map(|t| t.encode_with_ordinary(text).len())
            .unwrap_or(0),
    }
}
```

- [ ] **Step 2: 编译验证**

Run: `cd crates/lume-natives && cargo check`
Expected: 编译通过

- [ ] **Step 3: 构建 .node 二进制**

Run: `cd crates/lume-natives && cargo build --release`

如果交叉编译问题，先验证本平台：
```bash
cargo build --release --manifest-path crates/lume-natives/Cargo.toml
```

Expected: `target/release/liblume_natives.dylib`（macOS）生成成功

- [ ] **Step 4: 提交**

```bash
git add crates/lume-natives/src/tokens.rs
git commit -m "feat(natives): add token counting module from omp tiktoken-rs"
```

---

### Task 3: 创建 @lume/natives TS 包

**Files:**
- Create: `packages/natives/package.json`
- Create: `packages/natives/index.ts`
- Create: `packages/natives/src/tokens.ts`

- [ ] **Step 1: 创建 package.json**

```json
{
  "name": "@lume/natives",
  "version": "0.1.0",
  "type": "module",
  "main": "./index.ts",
  "types": "./index.ts",
  "scripts": {
    "build:macos": "cargo build --release --manifest-path ../../crates/lume-natives/Cargo.toml && mkdir -p ./dist && cp ../../crates/lume-natives/target/release/liblume_natives.dylib ./dist/lume-natives.darwin-arm64.node",
    "build:macos-dev": "cargo build --manifest-path ../../crates/lume-natives/Cargo.toml && mkdir -p ./dist && cp ../../crates/lume-natives/target/debug/liblume_natives.dylib ./dist/lume-natives.darwin-arm64.node",
    "build:linux": "cargo build --release --manifest-path ../../crates/lume-natives/Cargo.toml && mkdir -p ./dist && cp ../../crates/lume-natives/target/release/liblume_natives.so ./dist/lume-natives.linux-x64-gnu.node"
  }
}
```

- [ ] **Step 2: 创建 src/tokens.ts**

```typescript
/**
 * Token counting via native Rust (tiktoken-rs).
 */

export interface TokenCountInput {
  text: string | string[];
  model?: string;
}

export interface TokenCountResult {
  count: number;
}

export type NativeModule = {
  countTokens(input: TokenCountInput): TokenCountResult;
};
```

- [ ] **Step 3: 创建 index.ts（native 加载器 + 导出）**

```typescript
/**
 * @lume/natives — High-performance Rust primitives for Lume.
 *
 * Loads the platform-specific .node binary and exposes typed APIs.
 * Falls back gracefully when native binary is unavailable.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NativeModule } from "./src/tokens.js";

// ── Native loader ──────────────────────────────────────

let _native: NativeModule | null = null;
let _loadError: string | null = null;

function loadNative(): NativeModule | null {
  if (_native !== null || _loadError !== null) return _native;

  try {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const platform = process.platform;
    const arch = process.arch;

    let binaryName: string;
    if (platform === "darwin" && arch === "arm64") {
      binaryName = "lume-natives.darwin-arm64.node";
    } else if (platform === "darwin" && arch === "x64") {
      binaryName = "lume-natives.darwin-x64.node";
    } else if (platform === "linux" && arch === "x64") {
      binaryName = "lume-natives.linux-x64-gnu.node";
    } else if (platform === "win32" && arch === "x64") {
      binaryName = "lume-natives.win32-x64-msvc.node";
    } else {
      _loadError = `unsupported platform: ${platform}-${arch}`;
      return null;
    }

    const binaryPath = path.join(__dirname, "dist", binaryName);
    _native = require(binaryPath) as unknown as NativeModule;
    return _native;
  } catch (err) {
    _loadError = `failed to load native module: ${err}`;
    console.warn("[@lume/natives]", _loadError);
    return null;
  }
}

export function isNativeAvailable(): boolean {
  return loadNative() !== null;
}

// ── Tokens ─────────────────────────────────────────────

export interface TokenCountInput {
  text: string | string[];
  model?: string;
}

export interface TokenCountResult {
  count: number;
}

/**
 * Count BPE tokens. Uses O200kBase (GPT-4o) by default.
 * Returns null if native module unavailable.
 */
export function countTokens(input: TokenCountInput): TokenCountResult | null {
  const native = loadNative();
  if (!native) return null;
  return native.countTokens(input);
}

/**
 * Count tokens for a single string. Convenience wrapper.
 * Returns 0 if native module unavailable.
 */
export function countStringTokens(
  text: string,
  model?: string
): number {
  const result = countTokens({ text, model });
  return result?.count ?? 0;
}
```

- [ ] **Step 4: 构建 native 二进制并验证加载**

```bash
# 构建 Rust
cd crates/lume-natives && cargo build --release && cd ../..

# 复制到 packages
mkdir -p packages/natives/dist
cp crates/lume-natives/target/release/liblume_natives.dylib packages/natives/dist/lume-natives.darwin-arm64.node

# 验证加载（在 Bun 中）
cd packages/natives && bun -e "import { isNativeAvailable, countStringTokens } from './index.ts'; console.log('native:', isNativeAvailable()); console.log('tokens:', countStringTokens('hello world'));"
```

Expected: 输出 `native: true` 和 `tokens: 2`（或类似数值）

- [ ] **Step 5: 提交**

```bash
git add packages/natives/
git commit -m "feat(natives): create @lume/natives TS package with token counting"
```

---

## Phase 2: 搜索基础设施（grep + glob + fd）

### Task 4: 移植 task 模块（取消令牌 + NAPI 异步任务）

**Files:**
- Create: `crates/lume-natives/src/task.rs`
- Reference: omp `pi-natives/src/task.rs`（259 行）

- [ ] **Step 1: 从 omp 复制 task.rs 并适配**

omp 的 task.rs 包含：
- `AbortReason` 枚举
- `CancelToken`（心跳检测 + 超时 + 外部信号）
- `Blocking<T>` 实现 `napi::Task` trait（libuv 线程池）
- `Promise<T>` = `AsyncTask<Blocking<T>>`
- `blocking()` 和 `future()` 辅助函数

从 https://raw.githubusercontent.com/can1357/oh-my-pi/main/crates/pi-natives/src/task.rs 复制完整内容。

**需要修改的地方：**
1. 保留文件头的 MIT 版权声明
2. 其他内容保持不变（这个模块是独立的，不依赖 omp 其他模块）

在 `Cargo.toml` 中添加依赖：
```toml
tokio = { version = "1", features = ["rt-multi-thread", "sync", "time"] }
```

在 `lib.rs` 中取消注释：
```rust
pub mod task;
```

- [ ] **Step 2: 编译验证**

Run: `cd crates/lume-natives && cargo check`
Expected: 通过

- [ ] **Step 3: 提交**

```bash
git add crates/lume-natives/src/task.rs crates/lume-natives/Cargo.toml crates/lume-natives/src/lib.rs
git commit -m "feat(natives): add task module (CancelToken + Blocking) from omp"
```

---

### Task 5: 移植 fs_cache 模块（文件扫描缓存）

**Files:**
- Create: `crates/lume-natives/src/fs_cache.rs`
- Reference: omp `pi-natives/src/fs_cache.rs`（841 行）

- [ ] **Step 1: 从 omp 复制 fs_cache.rs 并适配**

从 https://raw.githubusercontent.com/can1357/oh-my-pi/main/crates/pi-natives/src/fs_cache.rs 复制。

**需要修改的地方：**
1. 保留 MIT 版权
2. `use crate::utils::env_uint;` — 改为 `use crate::utils;` 然后用 `utils::env_uint!()`
3. `use crate::task::{CancelToken, ...};` — 确认和 Task 4 的导出匹配
4. 在 Cargo.toml 中启用依赖：
   ```toml
   ignore = "0.4"
   dashmap = "6"
   ```

在 `lib.rs` 中取消注释：
```rust
pub mod fs_cache;
```

- [ ] **Step 2: 编译验证**

Run: `cd crates/lume-natives && cargo check`
Expected: 通过

- [ ] **Step 3: 提交**

```bash
git add crates/lume-natives/src/fs_cache.rs crates/lume-natives/Cargo.toml crates/lume-natives/src/lib.rs
git commit -m "feat(natives): add fs_cache module (mtime-keyed file scan cache) from omp"
```

---

### Task 6: 移植 glob_util 模块（glob 模式编译）

**Files:**
- Create: `crates/lume-natives/src/glob_util.rs`
- Reference: omp `pi-natives/src/glob_util.rs`（142 行）

- [ ] **Step 1: 从 omp 复制 glob_util.rs**

从 https://raw.githubusercontent.com/can1357/oh-my-pi/main/crates/pi-natives/src/glob_util.rs 复制。

**需要修改的地方：**
1. 保留 MIT 版权
2. 在 Cargo.toml 中启用依赖：
   ```toml
   globset = "0.4"
   ```

在 `lib.rs` 中取消注释：
```rust
pub mod glob_util;
```

这个模块非常独立，基本不需要改。

- [ ] **Step 2: 编译验证**

Run: `cd crates/lume-natives && cargo check`
Expected: 通过

- [ ] **Step 3: 提交**

```bash
git add crates/lume-natives/src/glob_util.rs crates/lume-natives/Cargo.toml crates/lume-natives/src/lib.rs
git commit -m "feat(natives): add glob_util module (pattern compilation) from omp"
```

---

### Task 7: 移植 grep 模块（ripgrep 搜索引擎）

**Files:**
- Create: `crates/lume-natives/src/grep.rs`
- Reference: omp `pi-natives/src/grep.rs`（1,908 行）

- [ ] **Step 1: 从 omp 复制 grep.rs 并适配**

从 https://raw.githubusercontent.com/can1357/oh-my-pi/main/crates/pi-natives/src/grep.rs 复制。

**需要修改的地方：**
1. 保留 MIT 版权
2. `use crate::fs_cache::*;` — 确认和 Task 5 的导出匹配
3. `use crate::glob_util::*;` — 确认和 Task 6 的导出匹配
4. `use crate::task::{CancelToken, blocking, ...};` — 确认和 Task 4 的导出匹配
5. `use crate::utils::clamp_u32;` — 确认和 Task 1 的导出匹配
6. 在 Cargo.toml 中启用依赖：
   ```toml
   grep-matcher = "0.1"
   grep-regex = "0.1"
   grep-searcher = "0.1"
   memmap2 = "0.9"
   smallvec = "1"
   regex = "1"
   ```

在 `lib.rs` 中取消注释：
```rust
pub mod grep;
```

- [ ] **Step 2: 编译验证**

Run: `cd crates/lume-natives && cargo check`
Expected: 通过

- [ ] **Step 3: 提交**

```bash
git add crates/lume-natives/src/grep.rs crates/lume-natives/Cargo.toml crates/lume-natives/src/lib.rs
git commit -m "feat(natives): add grep module (ripgrep engine) from omp"
```

---

### Task 8: 移植 glob 模块（文件发现）

**Files:**
- Create: `crates/lume-natives/src/glob.rs`
- Reference: omp `pi-natives/src/glob.rs`（约 410 行）

- [ ] **Step 1: 从 omp 复制 glob.rs 并适配**

从 https://raw.githubusercontent.com/can1357/oh-my-pi/main/crates/pi-natives/src/glob.rs 复制。

**需要修改的地方：**
1. 保留 MIT 版权
2. 确认 `use crate::fs_cache::*` / `use crate::glob_util::*` / `use crate::task::*` 匹配

在 `lib.rs` 中取消注释：
```rust
pub mod glob;
```

- [ ] **Step 2: 编译验证**

Run: `cd crates/lume-natives && cargo check`
Expected: 通过

- [ ] **Step 3: 提交**

```bash
git add crates/lume-natives/src/glob.rs crates/lume-natives/src/lib.rs
git commit -m "feat(natives): add glob module (file discovery) from omp"
```

---

### Task 9: 移植 fd 模块（模糊文件查找）

**Files:**
- Create: `crates/lume-natives/src/fd.rs`
- Reference: omp `pi-natives/src/fd.rs`（249 行）

- [ ] **Step 1: 从 omp 复制 fd.rs 并适配**

从 https://raw.githubusercontent.com/can1357/oh-my-pi/main/crates/pi-natives/src/fd.rs 复制。

**需要修改的地方：**
1. 保留 MIT 版权
2. 确认 `use crate::fs_cache::*` / `use crate::task::*` / `use crate::utils::*` 匹配

在 `lib.rs` 中取消注释：
```rust
pub mod fd;
```

- [ ] **Step 2: 编译验证**

Run: `cd crates/lume-natives && cargo check`
Expected: 通过

- [ ] **Step 3: 全量构建 + 集成测试**

Run: `cd crates/lume-natives && cargo build --release`
Expected: `liblume_natives.dylib` 生成成功，包含所有模块

- [ ] **Step 4: 提交**

```bash
git add crates/lume-natives/src/fd.rs crates/lume-natives/src/lib.rs
git commit -m "feat(natives): add fd module (fuzzy file find) from omp"
```

---

### Task 10: TS 层接入 — 扩展 @lume/natives 并替换 Grep/Glob 工具

**Files:**
- Modify: `packages/natives/index.ts` — 增加 grep/glob/fd API
- Create: `packages/natives/src/grep.ts`
- Create: `packages/natives/src/glob.ts`
- Create: `packages/natives/src/fd.ts`
- Modify: `packages/sdk/src/tools/grep.ts` — 优先调 native
- Modify: `packages/sdk/src/tools/glob.ts` — 优先调 native

- [ ] **Step 1: 在 index.ts 中增加 grep/glob/fd 类型定义和导出**

在 `NativeModule` 类型中追加 grep/glob/fd 的函数签名。在导出部分增加 `nativeGrep()`、`nativeGlob()`、`nativeFuzzyFind()` 函数，内部调用 `_native.xxx()`，native 不可用时返回 null。

- [ ] **Step 2: 修改 grep.ts — 优先调 native grep**

在 `packages/sdk/src/tools/grep.ts` 的 `call` 函数开头增加：

```typescript
import { nativeGrep, isNativeAvailable } from "@lume/natives";

// 在构建 grep 参数之后、spawn('rg') 之前
if (isNativeAvailable()) {
  const nativeResult = nativeGrep({
    pattern,
    path: searchPath,
    glob: globFilter,
    context: contextLines,
    // ...映射其他参数
  });
  if (nativeResult !== null) {
    return nativeResult; // 直接返回 native 结果
  }
}
// fallback 到原有的 spawn('rg') 逻辑
```

- [ ] **Step 3: 修改 glob.ts — 优先调 native glob**

类似 grep.ts，在调用 Node.js glob API 或 bash 之前，优先尝试 `nativeGlob()`。

- [ ] **Step 4: 集成测试**

```bash
# 构建 native
cd crates/lume-natives && cargo build --release && cd ../..
cp crates/lume-natives/target/release/liblume_natives.dylib packages/natives/dist/lume-natives.darwin-arm64.node

# 启动 sidecar + web，在 agent 中测试
# 1. 让 agent 搜索一个 pattern → 验证 grep 走 native
# 2. 让 agent 列出 *.ts 文件 → 验证 glob 走 native
# 3. 验证 native 不可用时 fallback 到原有逻辑
```

- [ ] **Step 5: 提交**

```bash
git add packages/natives/ packages/sdk/src/tools/grep.ts packages/sdk/src/tools/glob.ts
git commit -m "feat(natives): wire native grep/glob into SDK tools with fallback"
```

---

## Phase 3: AST/摘要模块（可选）

### Task 11: 创建 lume-ast crate

**Files:**
- Create: `crates/lume-ast/Cargo.toml`
- Create: `crates/lume-ast/src/lib.rs`
- Create: `crates/lume-ast/src/language.rs`（从 omp `pi-ast/src/language.rs` 复制）
- Create: `crates/lume-ast/src/ops.rs`（从 omp `pi-ast/src/ops.rs` 复制）
- Create: `crates/lume-ast/src/summary.rs`（从 omp `pi-ast/src/summary.rs` 复制）

- [ ] **Step 1: 创建 lume-ast Cargo.toml**

从 https://raw.githubusercontent.com/can1357/oh-my-pi/main/crates/pi-ast/Cargo.toml 复制，去掉 omp workspace 继承，改为直接版本号。

**注意**：tree-sitter 语言语法非常多（50+），建议先只引入核心语言：
- tree-sitter-javascript, tree-sitter-typescript
- tree-sitter-rust, tree-sitter-python
- tree-sitter-go, tree-sitter-java
- tree-sitter-c, tree-sitter-cpp

- [ ] **Step 2: 复制 language.rs, ops.rs, summary.rs**

从 omp 对应文件复制，适配 import 路径。

- [ ] **Step 3: 在 lume-natives 中依赖 lume-ast**

在 `lume-natives/Cargo.toml` 中添加：
```toml
lume-ast = { path = "../lume-ast" }
ast-grep-core = "0.37"
```

在 `lume-natives/src/lib.rs` 中添加：
```rust
pub mod ast;
```

创建 `crates/lume-natives/src/ast.rs`（从 omp `pi-natives/src/ast.rs` 复制）。

- [ ] **Step 4: 编译 + 提交**

```bash
cd crates/lume-ast && cargo check
cd ../lume-natives && cargo check
git add crates/lume-ast/ crates/lume-natives/src/ast.rs
git commit -m "feat(ast): add lume-ast crate with tree-sitter summary + ast-grep from omp"
```

---

### Task 12: TS 层接入 summarize + ast

**Files:**
- Modify: `packages/natives/index.ts` — 增加 summarize/ast API
- Modify: `packages/sdk/src/tools/read.ts` — 大文件自动摘要

- [ ] **Step 1: 增加 native summarize 导出**

在 `@lume/natives` 中增加 `summarizeFile(path, options)` 封装。

- [ ] **Step 2: 修改 Read 工具 — 大文件自动摘要**

在 `read.ts` 中，当文件超过一定行数（如 500 行）时，自动调用 native summarize 生成结构化摘要返回给 agent，避免消耗大量 token。

- [ ] **Step 3: 提交**

```bash
git add packages/natives/ packages/sdk/src/tools/read.ts
git commit -m "feat(natives): wire native summarize into Read tool for large files"
```

---

## Phase 完成后验证

- [ ] **全量集成测试**

```bash
# 1. 构建
cd crates/lume-natives && cargo build --release && cd ../..
cp crates/lume-natives/target/release/liblume_natives.dylib packages/natives/dist/lume-natives.darwin-arm64.node

# 2. 启动应用
bun run dev

# 3. Agent 测试场景
# - "搜索项目中所有 TODO" → 验证 native grep
# - "列出所有 .ts 文件" → 验证 native glob
# - "读一下 src/main.ts"（大文件）→ 验证 native summarize
# - "统计这段文本的 token 数" → 验证 native tokens
# - 断开 native 二进制 → 验证 fallback 到 spawn('rg')
```

---

## 依赖总览

### lume-natives Cargo.toml 完整依赖

```toml
[dependencies]
napi = { version = "3", features = ["napi9", "error_anyhow"] }
napi-derive = "3"

# tokens
tiktoken-rs = "0.6"
rayon = "1.10"

# grep
grep-matcher = "0.1"
grep-regex = "0.1"
grep-searcher = "0.1"
memmap2 = "0.9"
smallvec = "1"
regex = "1"

# glob + fd + fs_cache
globset = "0.4"
ignore = "0.4"
dashmap = "6"

# task
tokio = { version = "1", features = ["rt-multi-thread", "sync", "time"] }

# common
serde = { version = "1", features = ["derive"] }
serde_json = "1"

# ast（Phase 3）
# lume-ast = { path = "../lume-ast" }
# ast-grep-core = "0.37"
```

### Task 依赖图

```
Task 1 (骨架) ──→ Task 2 (tokens) ──→ Task 3 (TS 包)
                                    ↓
Task 4 (task)  ──→ Task 5 (fs_cache) ──→ Task 7 (grep) ──→ Task 10 (接入)
                  Task 6 (glob_util) ──┤ Task 8 (glob)  ──→ Task 10
                                        Task 9 (fd)    ──→ Task 10

Task 11 (lume-ast) ──→ Task 12 (summarize 接入)  [独立，Phase 3]
```
