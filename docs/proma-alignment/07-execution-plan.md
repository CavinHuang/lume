# Proma → Lume 对齐执行结果

## 状态

✅ 已完成（2026-04-09）

当前 `docs/proma-alignment/` 中列出的 P0 / P1 对齐项已经全部落地，文档状态已与代码实现同步。

## 本次收尾内容

### 1. 补齐 P0-1 缺失实现

已完成以下代码补齐：
- 在 `apps/sidecar/src/services/agent/agent-prompt-builder.ts` 新增 `buildBuiltinAgents()`
- 预注册 `explorer` / `researcher` / `code-reviewer` 三个内置 SubAgent
- 在 `apps/sidecar/src/services/pi-agent/runtime-core/run.ts` 通过 `createAgent({ agents })` 接入运行时注册
- 补充测试覆盖，确保内置 agents 不只是 prompt 文案

### 2. 回写对齐文档状态

已将以下文档标记为已完成：
- `00-overview.md`
- `01-p0-builtin-subagents.md`
- `02-p0-context-knowledge.md`
- `03-p0-uncertainty-handling.md`
- `04-p1-tool-builder-skill.md`
- `05-p1-memory-prompt.md`
- `06-p1-skill-improvement.md`

## 验证结果

已验证：
- `bun test apps/sidecar/src/services/agent/agent-prompt-builder.test.ts`
- `bun test apps/sidecar/src/services/pi-agent/runtime-core/run.test.ts`
- `bun run typecheck`

结果：全部通过。

## 当前对齐结论

| 项目 | 状态 | 说明 |
|------|------|------|
| P0-1 内置 SubAgent 定义 | ✅ | 已补齐定义、运行时注册、测试 |
| P0-2 `.context` 知识管理体系 | ✅ | prompt 与 bootstrap 指引已存在 |
| P0-3 不确定性处理策略 | ✅ | 已按 `permissionMode` 区分 |
| P1-1 `tool-builder` Skill | ✅ | 默认 Skill 已存在 |
| P1-2 记忆系统 Prompt 优化 | ✅ | 哲学引导与写入规则已存在 |
| P1-3 `skill_improvement_hint` | ✅ | 动态上下文已按条件注入 |

## 后续建议

如果继续推进下一轮对齐，建议按以下顺序：

1. 做一次真实会话级 smoke，验证主线程是否会实际调用 `explorer` / `code-reviewer`
2. 重新扫描 Proma 新增能力，确认当前差距清单是否还有遗漏
3. 若要进入发布前收尾，可补一份人工验证记录，覆盖 create workspace / chat send-stream / agent send-stream / restart restore
