# Lume CLI V1 Design

> 日期: 2026-04-22  
> 状态: 已批准（对话确认）  
> 范围: Headless-first、agent-first 的 Lume CLI 第一版

## 概述

Lume 现有能力已经覆盖工作区、线程、文件附加、记忆、自动化、技能与运行时，但这些能力主要以桌面 UI、sidecar RPC、内部服务的形式存在。对 agent 而言，这会带来两个问题：

1. 能力需要逐个注册成工具，表面积偏大
2. 同一类对象缺少稳定、可记忆的命令面，skill 很难只靠“教会 agent 用 CLI”来复用能力

本设计的目标，是为 Lume 补一层产品级 CLI，让 agent 可以通过少量稳定命令完成工作区、线程、文件附加、发起对话这些高频动作，而不是继续依赖越来越多的专用工具注册。

V1 不追求覆盖全部能力，而是只构建最小可用闭环。

## 设计目标

### 主要目标

1. 提供一套适合 skill 直接教给 agent 使用的稳定 CLI 命令面
2. 让 CLI 在无桌面环境下也成立，作为 Lume 的一等 headless 运行入口
3. 优先覆盖 agent 高频主链路：工作区、线程、文件附加、发起一次对话
4. 默认输出适合机器消费，减少 agent 对表格、人类文案、模糊格式的依赖
5. 命令帮助文本需要像产品 CLI 一样易扫读，而不是暴露内部 RPC 名称

### 非目标

1. V1 不覆盖全部现有 Lume 能力
2. V1 不把 sidecar IPC 名称一比一映射成 CLI 契约
3. V1 不依赖桌面 app 才能工作
4. V1 不引入复杂的流式事件协议、复杂错误码体系、复杂批量操作
5. V1 不在第一版里暴露技能、记忆、自动化、配置、运行观察等完整子系统

## 设计原则

### 1. Headless runtime first

CLI 是 Lume 的一等运行面，不是桌面 app 的薄壳。桌面只是一个前端，CLI 本身应能在无桌面环境下完成 V1 范围内的动作。

### 2. Agent first

默认输出优先为 agent / 脚本消费设计：

- 非流式命令默认输出 JSON
- 成功结果写 `stdout`
- 错误信息写 `stderr`
- 保持稳定、低歧义、低装饰

### 3. Resource-first 内核，产品化外观

底层对象模型仍然围绕 workspace / thread / file，但对外命令帮助要更像产品 CLI，而不是内部 RPC 名称或过深资源树。

### 4. 克制优先

V1 只保留真正高频、能形成闭环的命令，不预先设计完整命令宇宙。

## V1 范围

V1 只包含以下能力面：

- `status`
- `health`
- `workspaces`
- `workspace create`
- `threads`
- `thread create`
- `thread messages`
- `thread send`
- `files`
- `file add`
- `ask`
- `version`
- `help`

V1 明确不包含：

- `workspace update/remove`
- `thread move/fork/pin/model/search`
- `file move/remove/folder attach/workspace-to-thread attach`
- `skill`
- `memory`
- `automation`
- `config`
- `run/watch`

## 命令形态

参考 Alma CLI 的整体观感，V1 命令面采用“列表型复数命令 + 资源动作型单数命令”的混合写法。

建议的 help 形状如下：

```text
lume status
lume health

lume workspaces
lume workspace create <name>

lume threads [limit]
lume thread create [--workspace <slug>] [--title <title>]
lume thread messages <id> [limit]
lume thread send <id> <text>

lume files --thread <id>
lume files --workspace <slug>
lume file add --thread <id> <path>
lume file add --workspace <slug> <path>

lume ask <text> [--workspace <slug>] [--thread <id>]
lume version
lume help
```

### 命令命名规则

1. 列表型资源优先用复数命令：
   - `workspaces`
   - `threads`
   - `files`

2. 资源动作优先用单数命令：
   - `workspace create`
   - `thread create`
   - `thread send`
   - `file add`

3. 使用产品化动词，而不是内部术语：
   - 用 `create`，不用 `add`
   - 用 `send`，不用 `message send`

## 标识规则

V1 的对象标识采用混合策略：

- workspace 使用 `slug`
- thread 使用 `id`
- file 使用目标作用域内的相对路径

理由如下：

1. workspace 是长期存在、对人可读的容器，适合用 `slug`
2. thread 是运行时会话对象，适合用稳定内部 `id`
3. file 的读写目标天然依赖作用域与相对路径

## 输出契约

### 默认输出

除 `ask` 外，V1 命令默认输出 JSON。

输出规则：

- 成功结果只写 `stdout`
- 错误结果只写 `stderr`
- JSON 字段稳定、扁平、避免花哨包装

### 示例

`lume workspaces`

```json
[
  {
    "id": "ws_123",
    "slug": "default",
    "name": "Default",
    "path": "/abs/path",
    "createdAt": 1710000000000,
    "updatedAt": 1710000000000
  }
]
```

`lume thread create --workspace default`

```json
{
  "id": "th_123",
  "workspaceId": "ws_123",
  "workspaceSlug": "default",
  "title": "New thread",
  "createdAt": 1710000000000,
  "updatedAt": 1710000000000
}
```

`lume thread send th_123 "hello"`

```json
{
  "threadId": "th_123",
  "messageId": "msg_123",
  "status": "accepted"
}
```

`lume files --thread th_123`

```json
[
  {
    "name": "brief.md",
    "path": "brief.md",
    "kind": "file",
    "size": 1280
  }
]
```

`lume ask "总结这个项目" --workspace default`

- 默认输出最终文本结果
- V1 不设计复杂事件流协议
- 如果后续需要结构化结果，再新增显式参数，例如 `--json`

## 错误契约

V1 只保留少量退出码：

- `0`：成功
- `1`：未分类错误
- `2`：参数或用法错误
- `3`：资源不存在
- `4`：前置条件不满足

错误输出统一为 JSON 结构：

```json
{
  "error": {
    "code": "THREAD_NOT_FOUND",
    "message": "Thread 'th_123' was not found"
  }
}
```

## 行为细则

### `lume status`

- 只回答 CLI / runtime 是否可用
- 成功时返回简短 JSON，例如：

```json
{
  "ok": true,
  "runtime": "ready"
}
```

- 不隐式启动任何后台进程

### `lume health`

- 提供比 `status` 更详细的诊断信息
- 用于检查 headless runtime、配置目录、基础存储等是否正常
- 保持只读，不做自动修复

### `lume workspaces`

- 返回工作区列表
- V1 不分页
- 默认按最近更新时间倒序

### `lume workspace create <name>`

- 创建一个工作区
- 默认自动生成 slug
- 支持 `--slug`
- 如果 slug 冲突，直接报错，不自动追加后缀
- 返回完整 workspace 对象

### `lume threads [limit]`

- 返回最近线程列表
- `limit` 可选，默认值建议为 20
- 支持 `--workspace <slug>` 过滤

### `lume thread create`

- 创建空线程
- 不自动发送消息
- 支持 `--workspace <slug>`
- 支持 `--title <title>`
- 返回完整 thread 对象

### `lume thread messages <id> [limit]`

- 返回线程消息列表
- 仅做只读查询
- V1 不提供搜索、版本历史、截断、compact 等衍生能力

### `lume thread send <id> <text>`

- 向指定线程追加一条用户消息
- 触发一次运行
- 成功仅返回“已接受”结果
- V1 不返回完整流式 transcript
- V1 仅支持纯文本输入

### `lume files --thread <id>`

- 列出线程作用域文件
- 返回轻量元信息，如路径、类型、大小
- 不返回文件内容

### `lume files --workspace <slug>`

- 列出工作区共享文件
- 只看工作区共享范围
- 不混入线程文件

### `lume file add --thread <id> <path>`

- 将本地文件附加到线程作用域
- V1 仅支持单文件
- 不支持文件夹
- 同名冲突直接报错，不自动覆盖
- 成功返回目标路径与结果元信息

### `lume file add --workspace <slug> <path>`

- 将本地文件附加到工作区共享范围
- 规则与线程附加一致
- V1 不支持“从 workspace 附加到 thread”

### `lume ask <text>`

- 这是 V1 的高频快捷命令
- 默认行为是：创建新线程并发送首条消息
- 如果传 `--workspace <slug>`，新线程归属该 workspace
- 如果传 `--thread <id>`，则不创建线程，直接续写指定线程
- `--thread` 优先级高于“默认新建”
- 默认输出最终文本，不输出 JSON 事件流
- V1 不自动附加文件，不自动猜测最近线程

## 快捷命令语义

`ask` 是对 canonical 行为的薄封装，不代表一套新的对象模型。

其底层语义可等价理解为：

1. 若指定 `--thread <id>`：直接向该线程发送消息
2. 否则：创建线程
3. 再发送首条消息
4. 输出最终文本结果

## V1 明确不做

为了避免过度设计，V1 明确不做以下内容：

1. 不自动启动桌面 app 或依赖桌面 app 执行命令
2. 不做隐式资源创建，除了 `ask` 默认创建线程
3. 不做文件覆盖、自动 rename、自动 merge
4. 不做批量操作
5. 不做复杂流式事件协议
6. 不做文件夹支持
7. 不做工作区文件到线程的复用动作

## 设计收益

这套 V1 命令面可以让 skill 直接教 agent 走通以下主链路：

1. `lume workspaces`
2. `lume workspace create <name>`
3. `lume thread create --workspace <slug>`
4. `lume file add --thread <id> <path>`
5. `lume thread send <id> <text>`

或者更短：

1. `lume ask <text> --workspace <slug>`

这样可以显著减少为工作区、线程、发消息、附加文件等能力分别注册专用工具的必要性。

## 后续演进方向

V1 稳定后，后续可以按资源面逐步扩展，而不破坏已有心智：

- `workspace update/remove`
- `thread search/delete/switch`
- `file remove/move/attach`
- `skill`
- `memory`
- `automation`
- `config`
- `run/watch`

这些都应建立在 V1 已经形成稳定用法之后，再逐步外放，而不是在第一版里一次性展开。
