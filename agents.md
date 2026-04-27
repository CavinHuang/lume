## Working agreements
- Write a cleanup plan before modifying code for cleanup/refactor/deslop work.
- 仅在清理已有测试保护的代码时才锁定行为；新增或无测试的代码不要为了仪式感补写测试。
- Prefer deletion over addition.
- Reuse existing utils and patterns before introducing new abstractions.
- No new dependencies without explicit request.
- Keep diffs small, reviewable, and reversible.
- 仅在改动涉及可测试逻辑时运行相关测试；样式、文案、纯 UI 调整无需运行测试。不要为了"证明完成"而执行全量 lint/typecheck/test，只在改动有风险或涉及公共接口时验证。
- Final reports must include changed files, simplifications made, and remaining risks.

Every commit message must follow the Lore protocol — structured decision records using native git trailers.
Commits are not just labels on diffs; they are the atomic unit of institutional knowledge.

### Format

```
<emoji> <type>(<scope>): <中文描述>

<body: narrative context — constraints, approach rationale>
```

- **scope**: 受影响的模块，如 `web`, `sidecar`, `sdk`, `shared`
- **描述**: 使用中文，简明扼要说明改了什么

### Gitmoji Reference

| Emoji | Type | Example |
|-------|------|---------|
| ✨ | `feat` | ✨ feat(web): 添加流式工具执行器 |
| 🐛 | `fix` | 🐛 fix(sidecar): 修复子代理串行执行问题 |
| ♻️ | `refactor` | ♻️ refactor(sdk): 重构 provider 类型定义 |
| 📝 | `docs` | 📝 docs: 更新提交协议文档 |
| ✅ | `test` | ✅ test(sdk): 添加流式执行测试 |
| 🎨 | `style` | 🎨 style(web): 统一代码格式 |
| ⚡️ | `perf` | ⚡️ perf(sidecar): 优化消息解析性能 |
| 🔒 | `security` | 🔒 fix(sdk): 修复 token 泄露风险 |
| 🔧 | `chore` | 🔧 chore: 更新依赖版本 |
| ⬆️ | `deps` | ⬆️ deps: 升级 anthropic sdk |
| ⏪️ | `revert` | ⏪️ revert(sdk): 回退并行代理改动 |
| 🚀 | `release` | 🚀 release: v1.2.0 |
| 💄 | `ui` | 💄 ui(web): 优化模型选择器样式 |
| 🏗️ | `arch` | 🏗️ arch(sdk): 引入 StreamingToolExecutor 架构 |
| 🔥 | `remove` | 🔥 remove(web): 移除废弃组件 |

### Rules

1. **Gitmoji + type(scope) + 中文描述。** 首行格式 `<emoji> <type>(<scope>): <中文描述>`。
2. **scope 必填。** 标明受影响的模块：`web`, `sidecar`, `sdk`, `shared`，跨模块用 `,` 分隔如 `feat(web,sdk)`。
3. **描述用中文。** 简明说明改了什么，不超过 72 字符。
4. **Body 可选。** 需要补充上下文时写 body，说明原因和约束。
5. **Trailer 可选。** 使用 git-native 格式，常用：`Constraint:`, `Rejected:`, `Tested:`, `Not-tested:`。

### Example

```
🐛 fix(sidecar): 修复长时间运行时静默断开会话

Auth 服务在 token 过期时返回不一致的状态码，
因此拦截器捕获所有 4xx 响应并触发内联刷新。

Constraint: Auth 服务不支持 token 内省
Constraint: 不能给非过期 token 路径增加延迟
Rejected: 延长 TTL 到 24h | 违反安全策略
Rejected: 定时后台刷新 | 并发请求竞态条件
Tested: 单个过期 token 刷新（单元测试）
Not-tested: Auth 服务冷启动 > 500ms 场景
```

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

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
