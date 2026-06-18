---
name: release-notes
description: Use when generating release notes from git commits for a versioned release. Stores user-facing Markdown in docs/release/vX.Y.Z.md that CI reads directly for the GitHub Release body. Symptoms: "prepare release notes", "generate changelog for v0.2.0", "what should the release description say", "写发布说明".
---

# Release Notes Generator

生成用户可读的版本发布说明，CI 直接读取发布。

## Core Principle

Release notes are **not** a formatted changelog. They explain to users **what changed and why it matters to them** — written as if the team is walking them through the update.

```
commit 原始信息 → 用户视角翻译 → 发布说明
```

**禁止：** 将 raw commits 直接填入发布说明（如 `feat(ci): read release notes from file`）。每条都必须翻译为用户能理解的语言。

## Flow

```
确定版本 → 读取 commit → 分类 + 用户价值翻译 → 生成 Markdown → 写入 docs/release/vX.Y.Z.md → 预览确认
```

## Step 1: 确定版本

```bash
git describe --tags --abbrev=0    # 上一个 tag
cat package.json | grep '"version"'  # 当前版本
```

- 用户指定版本号（如 `v0.2.0`）→ 直接使用
- 用户说 "patch/minor/major" → 按 semver 递增
- 不确定 → 问用户

## Step 2: 读取 Commit 历史

```bash
git log <lastTag>..HEAD --oneline   # 有 tag 时
git log --oneline                    # 无 tag 时
```

## Step 3: 分类 + 用户价值翻译

### 分类

| 分类 | emoji | 前缀 | 是否面向用户 |
|------|-------|------|-------------|
| Features | 🚀 | `feat` | ✅ 是 |
| Bug Fixes | 🐛 | `fix` | ✅ 是 |
| Breaking Changes | ⚠️ | `BREAKING:` | ✅ 是（独立 section） |
| Refactoring | ♻️ | `refactor` | ❌ 内部 |
| Documentation | 📝 | `docs` | ❌ 内部 |
| Maintenance | 🔧 | `chore` | ❌ 内部 |
| Performance | ⚡ | `perf` | ✅ 是（如用户感知加速） |

未匹配 → `🔔 Other`

### 用户价值翻译（关键）

每条面向用户的 commit 翻译为 **用户能理解的语言**：

| 原始 commit | 用户视角翻译 |
|-------------|-------------|
| `feat(ci): read release notes from file` | 发布流程改进 — 发布说明现在自动生成 |
| `fix(desktop): tauri.conf.json pubkey` | 修复桌面端自动更新签名验证 |
| `chore: release script main flow` | 新的版本发布脚本，支持自动 bump + tag + push |

**规则：**
- 保留 scope 括号，补充一句中文解释变更范围
- 内部实现细节（如 "extract function", "use readFileSync"）→ 一句话概括目的，不列技术点
- 同类合并 — 同一 scope 下 3+ 相似 commit → 合并为一条，注明数量
- scope 信息必须保留，便于读者理解变更范围

### 破坏性变更（BREAKING）

- 提取 `BREAKING:` 前缀的 commit → 放入 **独立 section `## ⚠️ Breaking Changes`**
- 说明影响范围 + 迁移建议
- 放在 Highlights 之后，Features 之前

### 语言处理

commit message 可能混合中英文：
- 面向用户的部分 → 统一为 **中文说明**
- 保留技术术语原文（如 `tauri-action`, `bun`, `N-API`）

## Step 4: 生成发布说明

### 文件路径

```
docs/release/vX.Y.Z.md    # 必须有 v 前缀 — CI 读取 github.ref_name (如 v0.2.0)
```

### 模板

```markdown
# Lume vX.Y.Z

> 一句话概括本版本的核心变化，面向最终用户。

## 🔥 Highlights

面向用户的核心亮点，2-4 条。每条说明 **这是什么 + 对用户意味着什么**。

- 🚀 [功能名]: [用户能做什么新事情]
- 🐛 [修复名]: [解决了什么问题]

## ⚠️ Breaking Changes

如果有破坏性变更：

- `old-command` 已移除，请迁移到 `new-command`

## 🚀 Features

面向用户的新功能：

- feat(scope): 用户视角翻译
- ...

## 🐛 Bug Fixes

面向用户的问题修复：

- fix(scope): 用户视角翻译
- ...

## ⚡ Performance

面向用户的性能提升：

- perf: 用户视角翻译
- ...

## 🔧 Maintenance

内部改进（不影响用户直接使用）：

- chore: 发布流程自动化
- refactor: 代码重构提升可维护性
- ...

## 🔔 Other

未分类的变更

---

## 📊 变更概览

- X 个分类 · Y 个 commit
- 上一个版本: vX.Y.Z

## 🏗️ Build Info

| 平台 | 状态 |
|------|------|
| macOS (Apple Silicon) | ✅ |
| macOS (Intel) | ✅ |
| Windows | ✅ |
| Linux | ✅ |

- Auto-updater: ✅ 已签名
```

### 输出规则

1. **空的分类省略** — 无 commit 的 section 不显示
2. **Highlights 优先** — Features 中用户导向的亮点提取到顶部
3. **Breaking Changes 独立** — 有 BREAKING commit 时必须有此 section
4. **CI 兼容** — GitHub Markdown 格式，tauri-action 直接作为 Release body
5. **自包含** — 不依赖任何外部模板文件，skill 本身提供完整模板
6. **内部变更折叠** — refactor/chore/docs 折叠为一句概括，不逐条列出

## Step 5: 写入文件

```bash
mkdir -p docs/release
cat > docs/release/vX.Y.Z.md << 'EOF'
...
EOF
```

确认写入成功：
```bash
ls -la docs/release/vX.Y.Z.md
```

## Step 6: 预览确认

向用户展示生成的发布说明，等待确认后再继续版本 bump 和发布。

用户说 "修改"/"重新生成" → 根据反馈调整后重新输出。

## Checklist

- [ ] 文件名含 `v` 前缀（`v0.2.0.md` 而非 `0.2.0.md`）
- [ ] Highlights 面向用户，不是技术 changelog
- [ ] 无 raw commit 直接填入
- [ ] Breaking Changes 有独立 section（如有 BREAKING commit）
- [ ] 内部变更（refactor/chore/docs）已折叠概括
- [ ] 空分类已省略
- [ ] CI 可读取（`docs/release/vX.Y.Z.md`）

## Red Flags — 发布说明质量警告

出现以下情况说明发布说明不合格，必须修改：

- "这只是一次内部重构，没有用户可见变化" → 仍然需要一句话概括 + 折叠到 Maintenance
- "commit message 本身已经很清楚了" → 不对，面向用户的发布说明必须翻译，不能是技术 changelog
- "Highlights 没什么可写的" → 至少写一句版本概述，Internal 改进也可以写
- "BREAKING commit 和其他一起列就行" → 不对，必须有独立 `## ⚠️ Breaking Changes` section
- "用脚本 `scripts/release.mjs` 的 generateReleaseNotes 就行" → 那个函数是机械 formatter，发布说明需要人工翻译，不能依赖脚本
