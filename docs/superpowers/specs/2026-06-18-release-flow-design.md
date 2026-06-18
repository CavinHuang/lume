# Release Flow Design

**Date**: 2026-06-18
**Status**: Approved

---

## 1. Overview

设计一个从本地触发到 CI 完成的完整 Release 流程，核心思路：

> **本地生成 release notes → commit → push tag → CI 读取并发布**

Release notes 作为文件提交到仓库，CI 按 tag 名查找对应文件作为 release body。这样 notes 内容可控、可预览、可审查，不依赖 CI 中的字符串生成逻辑。

---

## 2. Release Notes 文件

**位置**：`docs/release/<tag>.md`，例如 `docs/release/v0.1.1.md`

**命名规则**：与 git tag 同名（去掉 `v` 前缀除外，直接使用 tag 全名），CI 通过 `${GITHUB_REF_NAME}` 定位。

**内容模板**：

```markdown
# Lume v0.1.1

## Highlights
1-2 句总结这个版本的核心变化。

## What's Changed
按 conventional commits 类型分组列出变更：
- feat(web): ...
- fix(desktop): ...
- chore: ...

## Build Info
- Platforms: macOS (ARM/Intel), Windows, Linux
- Updater: ✅ signed
```

**生成方式**：Agent 读取 `git log <last-tag>..HEAD --oneline`，按 commit type 自动分类，提炼 highlights。

---

## 3. 本地 Agent Skill

**触发**：用户输入 `release <version>`（如 `release v0.1.1`）

**执行流程**：

| 步骤 | 动作 | 说明 |
|------|------|------|
| 1 | 检查工作区干净 | 如有未提交变更，提醒用户 |
| 2 | 确认 last tag | `git describe --tags --abbrev=0` |
| 3 | 提取 commit log | `git log <last-tag>..HEAD --oneline` |
| 4 | 生成 notes 草案 | 按 conventional commits 分类 |
| 5 | 展示草案给用户 | 用户确认或编辑 |
| 6 | bump 版本号 | `package.json` root + desktop + `tauri.conf.json` |
| 7 | 写 `docs/release/<version>.md` | 用户确认后的版本 |
| 8 | git commit | 单次提交，包含 version bump + release notes |
| 9 | git push | 推到远程 |
| 10 | git tag + git push --tags | 触发 CI |

**交互点**：
- 版本号由用户在触发命令时指定
- Notes 草案生成后展示给用户确认，支持修改
- 检测到未提交变更时先提示

---

## 4. 版本号 Bump 范围

三个文件同步更新：

| 文件 | 路径 |
|------|------|
| Root package.json | `/package.json` |
| Desktop package.json | `/apps/desktop/package.json` |
| Tauri config | `/apps/desktop/src-tauri/tauri.conf.json` |

---

## 5. CI 改动

### 5.1 修复 Release 创建权限

**问题**：当前 `GITHUB_TOKEN` 没有创建 GitHub Release 的权限，tauri-action 报 `Resource not accessible by integration`。

**方案**：创建 Personal Access Token (PAT)，存为 GitHub Secret，替换 `GITHUB_TOKEN`。

```
1. GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic)
2. 生成 token，scope: repo
3. 存为仓库 Secret: RELEASE_TOKEN
4. workflow 中:
   env:
     GITHUB_TOKEN: ${{ secrets.RELEASE_TOKEN }}
```

### 5.2 读取 Release Notes

在 tauri-action 步骤中，CI 先读取 `docs/release/${GITHUB_REF_NAME}.md` 作为 release body：

```yaml
- name: Read release notes
  id: release_notes
  run: |
    if [ -f "docs/release/${{ github.ref_name }}.md" ]; then
      echo "body<<EOF" >> $GITHUB_OUTPUT
      cat docs/release/${{ github.ref_name }}.md >> $GITHUB_OUTPUT
      echo "EOF" >> $GITHUB_OUTPUT
    else
      echo "body=No release notes found." >> $GITHUB_OUTPUT
    fi

- name: Build and upload Tauri bundles
  uses: tauri-apps/tauri-action@v0
  with:
    releaseBody: ${{ steps.release_notes.outputs.body }}
    # 其余参数不变
```

### 5.3 现有流程保持不变

- 4-platform matrix build
- 3 个 pre-build 脚本（natives / sidecar / skills）
- `createUpdaterArtifacts: true`
- Draft release 模式（开发者审查后手动发布）

---

## 6. 完整流程图示

```
┌─────────────────────────────────────────────────────────┐
│  LOCAL                                                    │
│                                                           │
│  release v0.1.1                                          │
│       │                                                  │
│       ▼                                                  │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐ │
│  │ Analyze log │→ │ Generate     │→ │ User confirms  │ │
│  │             │  │ release notes│  │                │ │
│  └─────────────┘  └──────────────┘  └───────┬────────┘ │
│                                              │          │
│       ┌──────────────┐  ┌────────────┐     │          │
│       │ Bump version │→ │ Commit +   │◄────┘          │
│       │ (3 files)    │  │ Push       │                 │
│       └──────────────┘  └──────┬─────┘                 │
│                                │                        │
│       ┌────────────────────────▼─────┐                 │
│       │ git tag v0.1.1 && push       │                 │
│       └──────────────────────────────┘                 │
└─────────────────────────────────────────────────────────┘
                        │
                        ▼ push tag
┌─────────────────────────────────────────────────────────┐
│  CI (GitHub Actions)                                     │
│                                                           │
│  ┌──────────────────────────────────────────────────┐  │
│  │ Matrix: macOS ARM / Intel / Windows / Linux      │  │
│  │                                                    │  │
│  │ 1. bun install                                     │  │
│  │ 2. build workspace packages                        │  │
│  │ 3. build-natives / sidecar / skills                │  │
│  │ 4. tauri-action:                                   │  │
│  │    - tauri build --config tauri.release.conf.json  │  │
│  │    - sign with TAURI_SIGNING_PRIVATE_KEY           │  │
│  │    - createUpdaterArtifacts → latest.json + .sig   │  │
│  │    - create Draft Release with release notes       │  │
│  │    - upload bundles                                │  │
│  └──────────────────────────────────────────────────┘  │
│                                                           │
│  ┌────────────────┐                                      │
│  │ Developer       │                                      │
│  │ reviews draft   │                                      │
│  │ → Publish       │                                      │
│  └────────────────┘                                      │
│                                                           │
│  ┌────────────────┐                                      │
│  │ App at runtime  │                                      │
│  │ polls:          │                                      │
│  │ .../latest.json │                                      │
│  │ → verifies sig  │                                      │
│  │ → downloads &   │                                      │
│  │   installs      │                                      │
│  └────────────────┘                                      │
└─────────────────────────────────────────────────────────┘
```

---

## 7. 后续 TODO（不在本次范围内）

- [ ] `tauri.conf.json` 中 `__LUME_UPDATER_PUBLIC_KEY__` 占位符清理（`main.rs` 的 `option_env!` fallback 也应同步）
- [ ] 考虑自动 CHANGELOG 维护（`CHANGELOG.md` 由 release skill 自动追加）
