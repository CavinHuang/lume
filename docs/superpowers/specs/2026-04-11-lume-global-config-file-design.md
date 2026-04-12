# Lume 全局配置文件设计

- 日期: 2026-04-11
- 主题: `lume.yaml` 单文件系统配置落盘
- 状态: 已确认，待进入 implementation plan

## 1. 目标

Lume 需要一个统一、可落盘、可被 agent 修改、也可被用户直接编辑的系统配置入口。

本设计将所有“影响系统行为”的配置统一收口到：

- `C:\Users\A\.lume\lume.yaml`

该文件是唯一配置入口，用于覆盖系统默认配置，并支持按 workspace 做局部覆盖。

本设计的核心目标：

1. 用户只需要找一个文件即可理解和修改主要系统配置。
2. agent 有稳定、明确、单一的配置写入目标。
3. sidecar 能监听该文件并自动热加载。
4. workspace 可以有局部差异，但不再使用多份配置文件。
5. 配置系统只负责“系统配置”，不承载 UI 状态、草稿、临时状态等内容。

## 2. 非目标

本设计不处理以下内容：

1. UI 状态落盘：
   - 面板开关
   - 当前选中项
   - 草稿内容
   - 窗口位置和尺寸
2. 用户内容文件：
   - `SOUL.md`
   - `USER.md`
   - `AGENTS.md`
   - `TOOLS.md`
   - `MEMORY.md`
3. 对正在运行中的 agent 做强制中途重配置。
4. 多文件配置系统。
5. 复杂权限 DSL 或复杂配置继承系统。

## 3. 总体原则

### 3.1 单文件原则

Lume 只使用一个主配置文件：

- `C:\Users\A\.lume\lume.yaml`

不再新增：

- workspace 独立 `SETTINGS.yaml`
- `settings.json`
- 按领域拆分的配置文件

### 3.2 配置覆盖系统默认值

`lume.yaml` 的职责是“覆盖系统配置”。

它不是：

1. 应用运行时状态文件
2. 用户内容文件
3. agent 临时 scratchpad
4. 历史记录存储

换句话说，只有“会改变系统行为”的配置才进入 `lume.yaml`。

### 3.3 workspace 差异通过单文件内部表达

虽然只有一个全局配置文件，但仍然支持每个 workspace 的局部配置。

方式是通过：

- `workspaces.<slug>`

表达局部覆盖，而不是让每个 workspace 自己再持有一份配置文件。

## 4. 文件路径与命名

### 4.1 主配置文件

- `C:\Users\A\.lume\lume.yaml`

### 4.2 审计文件

配置变更审计单独落盘，不写回主文件：

- `C:\Users\A\.lume\lume.audit.jsonl`

### 4.3 命名约束

使用小写文件名：

- `lume.yaml`

原因：

1. 更像标准配置文件
2. 更适合 agent 稳定引用
3. 与未来跨平台路径习惯更一致

## 5. V1 覆盖范围

V1 只纳入会直接影响系统行为的配置。

### 5.1 纳入 `lume.yaml` 的 section

1. `agent`
2. `providers`
3. `mcp`
4. `skills`
5. `permissions`
6. `workspaces`

### 5.2 明确保留在现有状态/其它文件中的内容

以下内容不进入 `lume.yaml`：

1. `ui-state`
2. prompt sidebar 是否打开
3. 当前 conversation/thread/workspace 选择
4. chat/agent draft
5. agent side panel open map
6. 窗口尺寸、布局、位置
7. bootstrap 文档正文

## 6. 结构设计

### 6.1 顶层结构

推荐结构如下：

```yaml
version: 1

agent:
  defaultChannelId: "openai-default"
  defaultModelId: "gpt-5.4"
  permissionMode: "default"
  thinkingLevel: "medium"

providers:
  routing:
    defaultChannelId: "openai-default"
  channels:
    openai-default:
      enabled: true

mcp:
  servers:
    context7:
      enabled: true

skills:
  enabled:
    - "brainstorming"

permissions:
  toolPolicy:
    allow:
      - "read_file"
      - "list_directory"
    deny:
      - "delete_file"

workspaces:
  default:
    agent:
      defaultModelId: "claude-sonnet-4"
    mcp:
      servers:
        context7:
          enabled: false
    skills:
      enabled:
        - "brainstorming"
        - "docx"
```

### 6.2 设计理由

选择“顶层默认值 + `workspaces.<slug>` 覆盖块”的原因：

1. 对用户最直观
2. 对 agent 最容易稳定写入
3. 不需要理解多文件优先级
4. 便于 sidecar 生成 effective settings

## 7. 合并规则

### 7.1 生效规则

运行时 effective settings 的计算规则：

1. 读取系统默认配置
2. 读取 `lume.yaml` 顶层 section，覆盖系统默认配置
3. 如果当前 workspace slug 存在 `workspaces.<slug>`，再做一层覆盖
4. 生成当前 workspace 的 effective settings

### 7.2 覆盖范围

V1 只允许以下 section 参与覆盖：

1. `agent`
2. `providers`
3. `mcp`
4. `skills`
5. `permissions`

### 7.3 非法 section 处理

如果 `lume.yaml` 中出现 V1 不支持的 section：

1. 不报致命错误
2. 不生效
3. 记录 warning 日志
4. 在后续配置检查 UI 中可提示用户

## 8. 热加载策略

### 8.1 文件监听

sidecar 监听：

- `C:\Users\A\.lume\lume.yaml`

一旦文件变化：

1. 重新读取
2. 重新解析
3. 重新计算 effective settings
4. 向前端广播“配置已更新”事件

### 8.2 生效时机

V1 使用保守策略：

1. 新线程立即使用最新配置
2. 下一次发送消息使用最新配置
3. 正在运行中的 agent 不强制中断重配

### 8.3 原因

这样可以避免：

1. 正在运行的 tool permission 上下文突变
2. provider 切换导致的运行中会话不一致
3. 热加载直接打断用户当前执行

## 9. Agent 修改策略

### 9.1 Agent 可修改范围

agent 可以修改 `lume.yaml`，包括：

1. 顶层默认配置
2. `workspaces.<slug>` 的局部覆盖

### 9.2 写入方式

agent 不应通过随意文本替换直接写配置文件。

必须提供统一配置写入口，负责：

1. 读取当前文件
2. 解析 YAML
3. 校验 schema
4. 更新指定字段
5. 保持最小破坏性的序列化输出
6. 记录审计

### 9.3 审计要求

每次配置写入都记录到：

- `C:\Users\A\.lume\lume.audit.jsonl`

单条审计至少包含：

1. 时间
2. 来源
3. workspace slug（如果有）
4. 字段路径
5. 变更摘要

## 10. 与现有系统的关系

### 10.1 要逐步收口进 `lume.yaml` 的现有能力

本设计优先对齐这些现有能力：

1. 默认模型选择
2. provider / channel 选择
3. MCP 配置
4. skill 启用策略
5. permission / tool policy 配置

### 10.2 暂不强制迁移的内容

V1 不要求立刻把所有已有配置存储清空。

实现上允许：

1. 先新增 `lume.yaml` 读取链路
2. 再逐步让现有 UI 写入改走统一配置入口
3. 最后再清理旧配置存储

## 11. 错误处理

### 11.1 解析失败

如果 `lume.yaml` 格式错误：

1. 不覆盖当前已生效配置
2. 保留上一次成功加载的 effective settings
3. 返回结构化错误
4. 记录日志

### 11.2 部分字段非法

如果某个字段非法但整个文件可解析：

1. 忽略非法字段
2. 其它合法字段继续生效
3. 记录 warning

### 11.3 缺失文件

如果 `lume.yaml` 不存在：

1. 自动生成基础模板
2. 使用系统默认配置

## 12. V1 最小实现范围

V1 只需要落地以下能力：

1. `lume.yaml` 读取
2. YAML 解析与 schema 校验
3. 顶层默认值 + `workspaces.<slug>` 覆盖合并
4. sidecar 热加载监听
5. effective settings 查询接口
6. 配置写入口
7. 配置审计
8. 现有模型/provider/MCP/skill/permission 配置逐步接入

## 13. 预期收益

完成后，Lume 会得到一个统一的配置中心：

1. 用户知道去哪里改配置
2. agent 知道去哪里改配置
3. workspace 差异仍然存在
4. 配置系统与运行时状态分离
5. 后续可以在不改架构的前提下继续扩展更多系统配置

