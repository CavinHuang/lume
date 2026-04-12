# SDK Skill 注册扩展设计

- 日期: 2026-04-11
- 主题: 让 SDK 在创建 Agent 时显式接收 skill 来源，而不是只从固定路径加载
- 状态: 已确认，待进入 implementation plan

## 1. 背景

当前 Lume 的 workspace skill 体系与 SDK 的 filesystem skill 加载方式不一致。

SDK 当前只会从固定路径加载 filesystem skills：

1. `~/.claude/skills`
2. `<cwd>/.claude/skills`

而 Lume 当前的 skill 来源主要是：

1. `~/.lume/default-skills`
2. `~/.lume/agent-workspaces/<slug>/skills`

结果是：

1. Lume 自己可以扫描和展示 workspace skills
2. prompt 中也会把它们描述成 “Loaded Skills”
3. 但 SDK runtime 并不会真正从这些目录注册 skill

因此，当前 SkillTool 对 Lume workspace skills 的实际加载是不完整的。

## 2. 目标

让 SDK 从“硬编码固定 skill 路径”演进为“由宿主显式声明 skill 来源”。

具体目标：

1. SDK 在创建 Agent 时支持显式传入 skill 来源
2. Lume 可以把自己的 `default-skills` 和 `workspace/skills` 正式接入 SDK
3. 保留对旧 `.claude/skills` 路径的兼容
4. 为后续 Lume 自己计算 effective skills 留出升级路径

## 3. 非目标

本设计不做以下事情：

1. 不重写整个 SDK skill 系统
2. 不移除 bundled skills
3. 不立即废弃 legacy `.claude/skills`
4. 不在第一阶段强制 Lume 直接传 `SkillDefinition[]`
5. 不在本轮设计里处理 skill 市场、下载、版本管理

## 4. 总体方案

SDK 在 `AgentOptions` 增加两个新入口：

1. `skillsDirectories?: string[]`
2. `skills?: SkillDefinition[]`

创建 Agent 时，SDK 按明确顺序注册 skills：

1. bundled skills
2. 显式传入的 `skills`
3. `skillsDirectories`
4. legacy fallback filesystem paths

同名冲突时，后注册覆盖前注册。

这意味着 skill 来源不再由 SDK 偷偷决定，而是由宿主在创建 Agent 时显式声明。

## 5. SDK 接口设计

### 5.1 AgentOptions 新字段

在 SDK `AgentOptions` 中新增：

```ts
skills?: SkillDefinition[]
skillsDirectories?: string[]
```

语义：

- `skills`
  宿主已经解析好的 skill definitions，由 SDK 直接注册

- `skillsDirectories`
  宿主指定的 filesystem skill 根目录数组，由 SDK 负责扫描并解析

### 5.2 保留默认行为

如果宿主没有传这两个字段：

1. SDK 仍可保持当前 legacy 行为
2. 继续扫描默认 `.claude/skills`

但这个 legacy 行为应退化为 fallback，而不是主逻辑。

## 6. 注册顺序

### 6.1 统一注册顺序

Agent 初始化时，skill 注册顺序固定为：

1. bundled skills
2. `skills`
3. `skillsDirectories`
4. legacy fallback filesystem skills

### 6.2 冲突规则

同名 skill 冲突时，后注册覆盖前注册。

因此：

1. 宿主显式传入的 `skills` 可以覆盖 bundled
2. 宿主指定目录中的 skills 可以覆盖 bundled
3. legacy fallback 的优先级最低

## 7. SDK 内部改造点

### 7.1 filesystem loader

当前 `loadFilesystemSkills(cwd)` 只依赖固定路径。

需要演进为：

```ts
loadFilesystemSkills(options: {
  cwd: string
  roots?: string[]
  includeLegacyFallback?: boolean
})
```

行为：

1. 如果传了 `roots`，优先加载这些目录
2. `includeLegacyFallback` 为 `true` 时，再补上：
   - `~/.claude/skills`
   - `<cwd>/.claude/skills`
3. 去重后返回技能定义

### 7.2 Agent setup

`Agent.setup()` 中的 filesystem skill 注册逻辑要拆成两层：

1. 注册显式 skills
2. 注册 filesystem skills

并且要分别维护来源清理，避免刷新时老 skill 残留。

### 7.3 初始化结果

建议在 initialization/debug 输出中增加基础来源信息：

1. `skill.name`
2. `sourceType: bundled | explicit | directory | legacy`
3. `sourcePath?`

这不是 V1 UI 功能要求，但对宿主调试非常关键。

## 8. Lume 接入方案

### 8.1 第一阶段

Lume 在 `createRuntimeCoreSession()` 创建 agent 时传：

```ts
skillsDirectories: [
  "~/.lume/default-skills",
  "~/.lume/agent-workspaces/<slug>/skills"
]
```

实际实现时使用绝对路径。

第一阶段不强制 Lume 自己构造 `SkillDefinition[]`。

目标是先让 SDK 真正加载到 Lume skill 目录下的 skill。

### 8.2 第二阶段

Lume 后续再升级为：

1. 先根据 `lume.yaml` 计算 effective skills
2. 再直接传 `skills`
3. `skillsDirectories` 只保留给兼容或开发模式

这样 skill enable/disable、来源优先级、默认技能过滤就全部由 Lume 掌控。

## 9. 为什么不先只做 `skills`

只支持 `skills` 会让边界最干净，但会迫使 Lume 立刻承担：

1. filesystem 扫描
2. frontmatter 解析
3. 去重
4. 冲突处理
5. enable/disable 过滤

这会让首轮改造范围过大。

先支持 `skillsDirectories`，可以让 Lume 低成本接入，同时保留未来升级到 `skills` 的路径。

## 10. 为什么不先做 `skillLoader`

`skillLoader` 虽然最灵活，但复杂度明显更高：

1. 生命周期更复杂
2. 调试更难
3. 类型边界更重
4. 对首轮接入没有必要

因此，本轮不采用 callback 方案。

## 11. 风险与约束

### 11.1 同名覆盖风险

加入多来源后，同名覆盖必须稳定。

如果顺序不固定，会导致：

1. 同一个 skill 在不同环境下行为不一致
2. Lume 无法预测最终生效结果

所以注册顺序必须写死。

### 11.2 旧 skill 残留风险

如果 registry 刷新时不区分来源清理，可能导致：

1. 旧 directory skill 残留
2. 显式 skill 覆盖失效

因此 SDK 必须分来源维护：

1. bundled
2. explicit
3. filesystem
4. legacy

## 12. V1 最小实现范围

V1 只要求：

1. `AgentOptions` 新增 `skills` / `skillsDirectories`
2. filesystem loader 支持 roots 参数
3. Agent setup 按固定顺序注册 skills
4. Lume 在 runtime session 中传入默认 skill 目录和 workspace skill 目录
5. 保留 legacy `.claude/skills` fallback

## 13. 预期收益

完成后会得到：

1. SDK 不再被 `.claude/skills` 路径绑死
2. Lume 的 workspace skills 能真正进入 runtime skill registry
3. prompt 中的 “Loaded Skills” 与 runtime 实际可调用 skill 一致
4. 后续 Lume 可以逐步升级到完全由宿主控制 effective skills

