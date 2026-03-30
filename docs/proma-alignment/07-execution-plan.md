# 执行计划与验证

## 执行顺序

按依赖关系排序，建议分两个阶段实施：

### 阶段一：P0（必须对齐） — 预计 4-6 小时

| 顺序 | 编号 | 任务 | 前置依赖 | 估时 |
|------|------|------|---------|------|
| 1 | P0-3 | 不确定性处理策略 | 无 | 1h |
| 2 | P0-2 | .context 目录知识管理 | 无 | 1-2h |
| 3 | P0-1 | 内置 SubAgent 定义 | 无 | 2-3h |

**说明**：三个 P0 任务互不依赖，可并行开发。建议先做 P0-3（最小改动，立即可验证），再做 P0-2（纯 Prompt），最后做 P0-1（需确认运行时注册机制）。

### 阶段二：P1（高价值对齐） — 预计 3-4 小时

| 顺序 | 编号 | 任务 | 前置依赖 | 估时 |
|------|------|------|---------|------|
| 4 | P1-2 | 记忆系统 Prompt 优化 | 无 | 0.5h |
| 5 | P1-3 | Skill 改进提示 | 无 | 1h |
| 6 | P1-1 | tool-builder Skill | 无 | 2h |

**说明**：P1 任务同样互不依赖。P1-2 最简单可先做，P1-1 工作量最大放最后。

## 关键文件清单

### 主要修改文件

| 文件 | 涉及任务 | 修改类型 |
|------|---------|---------|
| `apps/sidecar/src/services/agent/agent-prompt-builder.ts` | P0-1, P0-2, P0-3, P1-2, P1-3 | 增加 Prompt 章节 |

### 新增文件

| 文件 | 涉及任务 | 说明 |
|------|---------|------|
| `apps/sidecar/default-skills/tool-builder/SKILL.md` | P1-1 | tool-builder Skill 定义 |

### 可能需要修改的文件

| 文件 | 涉及任务 | 说明 |
|------|---------|------|
| `packages/shared/src/types/agent.ts` | P0-1 | AgentDefinition 类型（如不存在） |
| pi-agent 运行时入口 | P0-1 | 注册内置 SubAgent |

## 风险与注意事项

### 技术风险

1. **P0-1 的运行时注册**：pi-agent (@mariozechner/pi-agent-core) 的 agents 注册机制与 Claude Agent SDK 不同，需要确认 API。这是最大的不确定性。
   - **缓解**：先完成 Prompt 层面的修改（SubAgent 委派策略），运行时注册可作为独立子任务

2. **permissionMode 传递路径**（P0-3）：需确认 Lume 中权限模式字段的命名和传递链路
   - **缓解**：先搜索 `permissionMode` 或 `permission` 在 sidecar 中的使用

3. **动态上下文注入点**（P1-3）：Lume 可能没有等价于 Proma `buildDynamicContext()` 的机制
   - **缓解**：可以退而求其次放在静态 system prompt 中，条件检查在构建时执行

### 设计原则

- **遵循 Lume 现有架构**：不引入新抽象层，修改尽量集中在 `agent-prompt-builder.ts`
- **增量可验证**：每个任务独立可测，完成一个验证一个
- **向后兼容**：所有修改都是追加性的，不破坏现有功能
- **token 预算**：新增 Prompt 内容总计约 1500-2000 tokens，在可接受范围内

## 验证检查清单

### 每个任务完成后

- [ ] `bun run typecheck` 通过
- [ ] 启动 sidecar，确认 System Prompt 输出包含新增章节
- [ ] 相关场景的行为测试（见各分片文档的验证方法）

### 全部完成后

- [ ] 完整的 Agent 会话测试：
  1. 新会话启动 → 检查是否读取 .context 目录
  2. 发送复杂任务 → 观察是否委派 SubAgent
  3. 发送模糊任务 → 观察不确定性处理行为
  4. 修正 Skill 输出 → 观察是否触发改进建议
  5. 创建自定义工具 → 验证 tool-builder Skill 流程
- [ ] Token 开销对比：测量新增 Prompt 内容对 token 消耗的影响
- [ ] 无回归：确认原有功能（memory、chat tools、skills 等）不受影响
