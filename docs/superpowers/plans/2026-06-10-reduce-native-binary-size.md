# 减少 lume-natives 二进制体积 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在保持所有现有功能的前提下，将 `lume-natives.darwin-arm64.node` 从 ~18MB 尽可能减小。

**Architecture:** 三管齐下 —— (1) 用 `tiktoken` crate 替换 `tiktoken-rs`，只嵌入实际使用的 2 个词表而非全部 5 个；(2) 将 tree-sitter 语法解析器拆分为核心集 + 可选集，按需加载；(3) 优化 release profile 参数。

**Tech Stack:** Rust, NAPI-RS (napi 3), tiktoken, tree-sitter 0.25, Cargo build profiles

---

## 体积来源分析

| 来源 | 当前大小 | 占比 |
|------|---------|------|
| tree-sitter 语法解析器 (15个) | ~10-11 MB | ~58% |
| tiktoken-rs 内嵌 BPE 词表 (5个) | ~5-7 MB | ~33% |
| 代码段 (tokio/rayon/grep等) | ~2.7 MB | ~15% |
| 未启用优化 (无 panic=abort 等) | ~355 KB | ~2% |

## 预期优化效果

| 优化项 | 预计节省 | 风险 |
|--------|---------|------|
| Task 1: 替换 tiktoken-rs → tiktoken | 2-4 MB | 低，API 兼容 |
| Task 2: 精简 release profile | 0.5-1 MB | 零风险 |
| Task 3: 延迟加载非核心 tree-sitter 语法 | 3-5 MB | 中，需改语言注册 |
| Task 4: 可选 — 去掉 C++ 语法 | 3.3 MB | 需确认业务需求 |

**保守估计总节省: 5-7 MB → 最终 ~11-13 MB**
**激进估计总节省: 8-10 MB → 最终 ~8-10 MB**

---

### Task 1: 替换 tiktoken-rs 为 tiktoken，只嵌入需要的词表

**Files:**
- Modify: `crates/lume-natives/Cargo.toml:13`
- Modify: `crates/lume-natives/src/tokens.rs`

**背景：** `tiktoken-rs` 0.6 通过 `include_str!()` 编译时嵌入全部 5 个 BPE 词表 (~8.3 MB)，但 lume 只用 `cl100k_base` 和 `o200k_base`。`tiktoken` crate (同作者) 可以更灵活地控制词表加载。

- [ ] **Step 1: 调研 tiktoken crate 的词表嵌入行为**

运行: `cargo search tiktoken` 并检查 `crates/lume-natives/Cargo.lock` 中是否已有 `tiktoken`（非 `tiktoken-rs`）。

在 `crates/lume-natives/` 目录下运行:
```bash
cargo tree -i tiktoken-rs
```

确认 `tiktoken-rs` 的依赖树。

然后检查 `tiktoken` crate 的 API 是否也使用 `include_str!`:
```bash
cargo info tiktoken 2>/dev/null || echo "检查 crates.io"
```

**决策点：** 如果 `tiktoken` crate 同样嵌入全部词表，则需要考虑替代方案：
- 方案 A: Fork `tiktoken-rs`，只保留 `o200k_base` 和 `cl100k_base` 的 `include_str!`
- 方案 B: 使用 `tiktoken-rs` 的 feature flag（如果有的话）
- 方案 C: 将词表文件外置为运行时加载（从 `~/.lume/` 或打包到 npm 包中）

- [ ] **Step 2: 实现选定的方案**

如果是**方案 A (fork 精简)**:

修改 `crates/lume-natives/Cargo.toml`，将 `tiktoken-rs` 替换为精简版:

```toml
# 替换
# tiktoken-rs = "0.6"
# 使用 tiktoken (如果它支持按需加载)
tiktoken = "0.1"
```

修改 `crates/lume-natives/src/tokens.rs`，更新 import:

```rust
use tiktoken::{o200k_base, cl100k_base, CoreBPE};
```

其余逻辑（`count_single`、`count_tokens`）不变。

如果是**方案 B (feature flag)**:

```toml
tiktoken-rs = { version = "0.6", default-features = false, features = ["o200k_base", "cl100k_base"] }
```

如果是**方案 C (运行时加载)**:

需要额外写一个 loader 函数，从磁盘读取词表文件。这会改变性能特征（首次调用有 IO 延迟），不推荐。

- [ ] **Step 3: 运行 token 计数测试确认功能正常**

```bash
cd crates/lume-natives
cargo test tokens
```

Expected: 测试通过

- [ ] **Step 4: 构建 release 并检查体积变化**

```bash
cd packages/natives
npm run build:macos
ls -lh dist/lume-natives.darwin-arm64.node
```

Expected: 二进制比之前的版本小 2-4 MB

- [ ] **Step 5: Commit**

```bash
git add crates/lume-natives/Cargo.toml crates/lume-natives/Cargo.lock crates/lume-natives/src/tokens.rs
git commit -m "perf(natives): replace tiktoken-rs with leaner alternative to reduce binary size"
```

---

### Task 2: 优化 release profile 参数

**Files:**
- Modify: `crates/lume-natives/Cargo.toml:34-36`

**背景：** 当前 profile 只有 `lto = true` 和 `strip = true`，缺少 `codegen-units = 1`、`opt-level = "z"`、`panic = "abort"`。

- [ ] **Step 1: 更新 Cargo.toml 的 [profile.release]**

修改 `crates/lume-natives/Cargo.toml` 的 `[profile.release]` 段:

```toml
[profile.release]
lto = true
strip = true
codegen-units = 1
opt-level = "z"
panic = "abort"
```

说明:
- `codegen-units = 1`: 让 LTO 跨所有代码单元优化，消除更多死代码
- `opt-level = "z"`: 优化二进制体积（相比 "s" 更激进）
- `panic = "abort"`: 移除 unwind 相关的异常表 (~355 KB)

**注意:** `panic = "abort"` 意味着 panic 时直接终止进程而不 unwind。这对 NAPI 库是安全的，因为 NAPI 不依赖 Rust panic unwinding。

- [ ] **Step 2: 全量构建验证**

```bash
cd crates/lume-natives
cargo clean
cargo build --release
ls -lh target/release/liblume_natives.dylib
```

Expected: 编译成功，二进制体积减小

- [ ] **Step 3: 运行全部 Rust 测试**

```bash
cd crates/lume-natives
cargo test
```

Expected: 所有测试通过

- [ ] **Step 4: 构建 .node 并运行集成验证**

```bash
cd packages/natives
npm run build:macos
ls -lh dist/lume-natives.darwin-arm64.node
```

- [ ] **Step 5: Commit**

```bash
git add crates/lume-natives/Cargo.toml
git commit -m "perf(natives): optimize release profile for binary size"
```

---

### Task 3: 将 tree-sitter 语法拆分为「核心」和「按需加载」

**Files:**
- Modify: `crates/lume-ast/Cargo.toml`
- Modify: `crates/lume-ast/src/language.rs`
- Create: `crates/lume-ast/src/lazy_grammar.rs` (新文件)
- Modify: `crates/lume-natives/Cargo.toml` (可选: 添加 feature flags)

**背景：** 15 个 tree-sitter 语法解析器编译后占 ~10-11 MB。其中 C++ 单个就 3.3 MB。并非所有语言都会高频使用。

**策略：** 将语法拆为两组:
- **核心语法**（编译时嵌入，始终可用）: TypeScript, JavaScript, Rust, Python, Go, JSON, Markdown, HTML, CSS, YAML, TOML — 这些是 AI 编程助手的日常语言
- **重型语法**（延迟初始化或条件编译）: C++, C, Java, Bash — 这些语法解析器体积大但使用频率低

**方案: 使用 feature flags 做条件编译**（最简单，不需要运行时 dlopen 的复杂性）

- [ ] **Step 1: 为 lume-ast 添加 feature flags**

修改 `crates/lume-ast/Cargo.toml`:

```toml
[features]
default = [
  "lang-typescript", "lang-javascript", "lang-rust",
  "lang-python", "lang-go", "lang-json", "lang-markdown",
  "lang-html", "lang-css", "lang-yaml", "lang-toml",
]
# 轻量核心语法 (每个 < 500 KB)
lang-typescript = ["dep:tree-sitter-typescript"]
lang-javascript = ["dep:tree-sitter-javascript"]
lang-rust = ["dep:tree-sitter-rust"]
lang-python = ["dep:tree-sitter-python"]
lang-go = ["dep:tree-sitter-go"]
lang-json = ["dep:tree-sitter-json"]
lang-markdown = ["dep:tree-sitter-md"]
lang-html = ["dep:tree-sitter-html"]
lang-css = ["dep:tree-sitter-css"]
lang-yaml = ["dep:tree-sitter-yaml"]
lang-toml = ["dep:tree-sitter-toml-ng"]
# 重型语法 (每个 > 500 KB)
lang-bash = ["dep:tree-sitter-bash"]
lang-c = ["dep:tree-sitter-c"]
lang-cpp = ["dep:tree-sitter-cpp"]
lang-java = ["dep:tree-sitter-java"]
# 快捷方式: 全部启用
all-languages = [
  "lang-typescript", "lang-javascript", "lang-rust", "lang-python",
  "lang-go", "lang-json", "lang-markdown", "lang-html", "lang-css",
  "lang-yaml", "lang-toml", "lang-bash", "lang-c", "lang-cpp", "lang-java",
]

[dependencies]
anyhow = "1"
serde = { version = "1", features = ["derive"] }
tree-sitter = "0.25"
# 核心语法 - 始终编译
tree-sitter-typescript = { version = "0.23", optional = true }
tree-sitter-javascript = { version = "0.25", optional = true }
tree-sitter-rust = { version = "0.24", optional = true }
tree-sitter-python = { version = "0.25", optional = true }
tree-sitter-go = { version = "0.25", optional = true }
tree-sitter-json = { version = "0.24", optional = true }
tree-sitter-md = { version = "0.5", optional = true }
tree-sitter-html = { version = "0.23", optional = true }
tree-sitter-css = { version = "0.25", optional = true }
tree-sitter-yaml = { version = "0.7", optional = true }
tree-sitter-toml-ng = { version = "0.7", optional = true }
# 重型语法 - 按需编译
tree-sitter-bash = { version = "0.25", optional = true }
tree-sitter-c = { version = "0.24", optional = true }
tree-sitter-cpp = { version = "0.23", optional = true }
tree-sitter-java = { version = "0.23", optional = true }
```

- [ ] **Step 2: 更新 language.rs 使用条件编译**

修改 `crates/lume-ast/src/language.rs`，用 `#[cfg(feature = "...")]` 标注每个语言变体:

```rust
use std::path::Path;
use tree_sitter::Language;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SupportLang {
    // 核心语法
    #[cfg(feature = "lang-javascript")]
    JavaScript,
    #[cfg(feature = "lang-typescript")]
    TypeScript,
    #[cfg(feature = "lang-rust")]
    Rust,
    #[cfg(feature = "lang-python")]
    Python,
    #[cfg(feature = "lang-go")]
    Go,
    #[cfg(feature = "lang-json")]
    Json,
    #[cfg(feature = "lang-markdown")]
    Markdown,
    #[cfg(feature = "lang-html")]
    Html,
    #[cfg(feature = "lang-css")]
    Css,
    #[cfg(feature = "lang-yaml")]
    Yaml,
    #[cfg(feature = "lang-toml")]
    Toml,
    // 重型语法
    #[cfg(feature = "lang-bash")]
    Bash,
    #[cfg(feature = "lang-c")]
    C,
    #[cfg(feature = "lang-cpp")]
    Cpp,
    #[cfg(feature = "lang-java")]
    Java,
}
```

对 `from_alias`, `from_path`, `get_ts_language`, `canonical_name` 四个方法的每个 `match` arm 也加上对应的 `#[cfg]`。

对于 `get_ts_language`，每个 arm:
```rust
#[cfg(feature = "lang-bash")]
Self::Bash => tree_sitter_bash::LANGUAGE.into(),
#[cfg(not(feature = "lang-bash"))]
Self::Bash => unreachable!("bash feature not enabled"),
```

**注意:** 由于 `SupportLang` 的变体在 `from_alias`/`from_path` 中被 match，当 feature 关闭时这些 match arm 不会存在。需要确保每个方法的所有 `#[cfg]` 标注一致。

- [ ] **Step 3: 更新 summary.rs 中的条件编译**

修改 `crates/lume-ast/src/summary.rs`，对 `is_comment_kind`, `is_elidable_kind`, `is_groupable_kind` 中的每个 `SupportLang::*` arm 加上 `#[cfg]`:

```rust
fn is_elidable_kind(language: SupportLang, kind: &str) -> bool {
    match language {
        #[cfg(feature = "lang-typescript")]
        SupportLang::TypeScript | #[cfg(feature = "lang-javascript")] SupportLang::JavaScript => matches!(...),
        #[cfg(feature = "lang-rust")]
        SupportLang::Rust => matches!(...),
        // ... 以此类推
    }
}
```

- [ ] **Step 4: 更新 lume-natives 的依赖**

修改 `crates/lume-natives/Cargo.toml`:

```toml
lume-ast = { path = "../lume-ast", default-features = true }
# 如果要去掉重型语法:
# lume-ast = { path = "../lume-ast", default-features = false, features = [
#   "lang-typescript", "lang-javascript", "lang-rust", "lang-python",
#   "lang-go", "lang-json", "lang-markdown", "lang-html", "lang-css",
#   "lang-yaml", "lang-toml",
# ] }
```

- [ ] **Step 5: 更新 TS 层的 SUMMARIZABLE_EXTENSIONS**

修改 `packages/sdk/src/tools/read.ts` 中的 `SUMMARIZABLE_EXTENSIONS`，去掉被禁用的语言扩展（如果有）:

```typescript
const SUMMARIZABLE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.rs', '.py', '.go',
  // 如果去掉 Java: 删除 '.java'
  // 如果去掉 C/C++: 删除 '.c', '.h', '.cpp', '.cc', '.cxx', '.hpp', '.hh'
  '.html', '.htm', '.css', '.scss',
  '.json', '.yaml', '.yml', '.toml',
  // 如果去掉 Bash: 删除 '.sh', '.bash'
  '.md',
])
```

- [ ] **Step 6: 全量编译并运行测试**

```bash
# 先用默认 feature 编译
cd crates/lume-ast
cargo test
cargo build

# 然后编译 lume-natives
cd ../lume-natives
cargo clean
cargo build --release

# 构建 .node
cd ../../packages/natives
npm run build:macos
ls -lh dist/lume-natives.darwin-arm64.node
```

Expected: 编译成功，二进制体积显著减小

- [ ] **Step 7: 运行 JS 层测试确认功能正常**

运行 sidecar 或相关测试:
```bash
# 在项目根目录运行相关的测试或启动 sidecar 验证
bun run --filter @lume/natives test 2>/dev/null || echo "无 JS 测试，跳过"
```

- [ ] **Step 8: Commit**

```bash
git add crates/lume-ast/ crates/lume-natives/Cargo.toml crates/lume-natives/Cargo.lock packages/sdk/src/tools/read.ts
git commit -m "perf(ast): add feature flags for tree-sitter grammars to reduce binary size"
```

---

### Task 4: （可选）去掉 C++ 语法解析器以获得最大体积节省

**Files:**
- Modify: `crates/lume-natives/Cargo.toml` (调整 lume-ast features)

**背景：** `tree-sitter-cpp` 单个就占 3.3 MB。如果 lume 的目标用户群主要做 Web/TS/Rust/Python 开发，去掉 C++ 语法解析器是性价比最高的单项优化。

**前置条件：** Task 3 完成（feature flags 已就绪）

- [ ] **Step 1: 从 lume-natives 的 lume-ast 依赖中排除重型语法**

修改 `crates/lume-natives/Cargo.toml`:

```toml
# 只启用核心语法
lume-ast = { path = "../lume-ast", default-features = false, features = [
  "lang-typescript", "lang-javascript", "lang-rust", "lang-python",
  "lang-go", "lang-json", "lang-markdown", "lang-html", "lang-css",
  "lang-yaml", "lang-toml",
  # 保留 Bash (1.3 MB 但实用) 和 C (630 KB 较小)
  "lang-bash", "lang-c",
  # 去掉: lang-cpp (3.3 MB), lang-java (420 KB)
] }
```

- [ ] **Step 2: 更新 read.ts 中的扩展名列表**

修改 `packages/sdk/src/tools/read.ts`:
```typescript
const SUMMARIZABLE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.rs', '.py', '.go',
  '.c', '.h',
  // 去掉了: '.cpp', '.cc', '.cxx', '.hpp', '.hh' (C++)
  // 去掉了: '.java' (Java)
  '.html', '.htm', '.css', '.scss',
  '.json', '.yaml', '.yml', '.toml',
  '.sh', '.bash', '.md',
])
```

- [ ] **Step 3: 构建并验证体积**

```bash
cd crates/lume-natives && cargo clean && cd ../..
cd packages/natives && npm run build:macos
ls -lh dist/lume-natives.darwin-arm64.node
```

Expected: 去掉 C++ 后应再省 ~3.3 MB

- [ ] **Step 4: Commit**

```bash
git add crates/lume-natives/Cargo.toml crates/lume-natives/Cargo.lock packages/sdk/src/tools/read.ts
git commit -m "perf(natives): exclude C++/Java tree-sitter grammars for maximum size reduction"
```

---

## 最终验证步骤

在所有 Task 完成后:

- [ ] **全量编译并对比体积**

```bash
# 清理后完整构建
cd crates/lume-natives && cargo clean
cd ../../packages/natives && npm run build:macos
ls -lh dist/lume-natives.darwin-arm64.node
```

记录最终体积，与原始 ~18MB 对比。

- [ ] **功能回归测试**

```bash
# Rust 单元测试
cd crates/lume-ast && cargo test
cd ../lume-natives && cargo test

# 启动 sidecar 验证 native 模块加载正常
cd apps/sidecar && bun run dev
```

验证:
1. ✅ Grep 搜索正常工作
2. ✅ Glob 文件发现正常工作
3. ✅ 大文件 Read 时 summarize 正常（对支持的语言）
4. ✅ Token 计数正常
5. ✅ Logger 正常写入日志
6. ✅ Fuzzy find 正常

- [ ] **最终 Commit**

```bash
git add -A
git commit -m "perf(natives): optimize native binary size (18MB → target <12MB)"
```
