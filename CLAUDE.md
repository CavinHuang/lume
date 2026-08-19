# CLAUDE.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

## 5. 改动工作流（worktree + PR，强制）

**禁止在 `main` 上直接修改代码。** 所有改动必须遵循以下顺序：

1. **先 pull main** —— 开发前确保本地 `main` 与 `origin/main` 同步。
2. **在 worktree 新分支上开发** —— 基于最新 `main` 为每个能力创建独立 worktree 与新分支，所有改动只在分支上完成。
3. **通过 PR 合并 main** —— 改动只能经 PR review 通过后合并回 `main`，禁止本地直接 merge 到 main。

## 6. 排版规范

新代码字号使用语义 token（`text-micro` / `text-caption` / `text-ui` / `text-body` / `text-body-lg` / `text-chat`），禁止新增 `text-[Npx]` 形式的字号 utility；行高跟随 token 配对值（`text-chat` 自带 1.85）。对话流内派生字号（标题/行内 code/代码块）用 em 相对量，保证档位联动。字号 token 命名避开颜色名（如 `secondary`/`muted` 已是 `--color-*`，会产生 `text-*` 解析歧义）。存量 `text-[Npx]` 触碰时顺手迁移，不做机械全量替换。

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.