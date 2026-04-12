# Lume Workspace / Thread 落盘结构重构设计

- 日期：2026-04-11
- 范围：`workspace` 与 `thread` 的真实磁盘目录组织、系统文件保留/删除策略、UI 语义与磁盘路径映射关系
- 目标：将 `Lume` 的实际落盘结构整理为稳定、可理解、可迁移的目录体系，避免系统文件、任务文件、元数据继续混杂

## 1. 背景

当前 `Lume` 的 workspace 与 thread 落盘结构存在以下问题：

- workspace 根目录同时承载系统文件、共享资料、配置文件、数据库，边界不清
- thread 工作目录直接挂在 workspace 根下，用户工作文件与系统辅助目录混放
- 部分历史设计（如 `BOOTSTRAP.md`、`.claude/`、`.note`）会增加上下文噪音，但实际价值有限
- UI 中的“当前任务文件 / 工作区共享文件 / 外部附加目录”三层模型，与真实磁盘结构之间缺少稳定映射

本次设计目标不是立刻实现所有迁移，而是先把未来长期稳定的真实目录结构设计清楚。

## 2. 设计目标

### 2.1 核心目标

- 让 `workspace` 成为唯一主根目录
- 让 `thread` 成为 workspace 下的明确子对象
- 保留少量明确有语义的根文件，删除一次性或冗余文件
- 将用户工作文件、共享资料、内部元数据明确分层

### 2.2 约束

- 允许 UI 名字和磁盘名字不同，但映射必须稳定
- 不能让 thread 根目录继续无边界堆放工作文件和系统目录
- 隐藏目录只承载内部状态，不承载主要用户语义

## 3. 根目录总原则

每个 workspace 未来应采用以下主干结构：

```text
workspace/
  AGENTS.md
  SOUL.md
  TOOLS.md
  IDENTITY.md
  USER.md
  MEMORY.md
  HEARTBEAT.md

  resources/
  threads/

  .meta/
```

### 3.1 设计原则

- workspace 根目录本身必须可读、可理解
- `resources/` 与 `threads/` 是两个主目录
- `.meta/` 只放内部状态与映射，不承担用户主语义
- 不允许未来继续随意向根目录追加语义模糊的新文件

## 4. 保留的 workspace 根文件

以下文件保留在 workspace 根目录：

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `MEMORY.md`
- `HEARTBEAT.md`

### 4.1 文件语义

- `AGENTS.md`
  工作区操作规则、行为边界、流程约束

- `SOUL.md`
  工作区级人格/精神内核定义，保持独立，不与 `IDENTITY.md` 合并

- `TOOLS.md`
  工作区专属工具约束文件，但必须保持非常短，只包含真正必要的规则

- `IDENTITY.md`
  当前工作区身份与定位

- `USER.md`
  与当前用户相关、且对该工作区有意义的上下文

- `MEMORY.md`
  工作区长期记忆，不依附单个 thread

- `HEARTBEAT.md`
  工作区心跳任务与主动行为约束，保留在根目录

## 5. 废弃与删除项

以下文件/目录应被废弃：

### 5.1 `BOOTSTRAP.md`

- 直接删除
- 不再创建
- 不再读取
- 不再注入上下文

原因：这是一次性引导文件，长期保留只会制造重复上下文。

### 5.2 `.claude/`

- 从 thread 目录中删除
- 不再作为 thread 运行配置目录存在

原因：其职责偏内部实现细节，不应继续出现在用户可见目录层。

### 5.3 `.note`

- 删除
- 不再作为 thread 内部辅助文件保留

原因：语义不稳定，容易增加目录噪音与上下文负担。

### 5.4 旧 thread 根混放模式

当前类似：

```text
workspace/<thread-id>/...
```

这种工作文件与系统目录混放的模式应废弃。

## 6. `resources/` 目录

`resources/` 是工作区共享文件的唯一稳定磁盘位置：

```text
workspace/
  resources/
    ...
```

### 6.1 语义

- 用于保存多个任务可复用的长期资料
- 对应 UI 中的“工作区共享文件”
- 不与临时附加目录混淆

### 6.2 规则

- 用户明确上传到共享层的文件进入 `resources/`
- 从任务层提升到共享层的文件，默认也进入 `resources/`
- 不允许用其他散落位置承载工作区共享资料

## 7. `threads/` 目录

每个 thread 在磁盘上采用以下结构：

```text
workspace/
  threads/
    <thread-id>/
      files/
      plans/
      artifacts/
      .context/
```

### 7.1 结构解释

- `<thread-id>/`
  thread 的真实磁盘锚点

- `files/`
  当前线程的工作文件。对应 UI 的“当前任务文件”

- `plans/`
  当前线程生成的计划文件

- `artifacts/`
  线程产出的结果物，例如导出文件、截图、汇总产物

- `.context/`
  thread 私有的系统辅助目录，保留

### 7.2 设计原则

- UI 中“当前任务文件”默认映射 `files/`
- 不直接把整个 `<thread-id>/` 根目录暴露为主文件区
- `plans/`、`artifacts/`、`.context/` 需要明确边界，不再混进普通工作文件层

## 8. `.meta/` 目录

`.meta/` 只用于承载内部状态与映射：

```text
workspace/
  .meta/
    attached-dirs.json
    workspace-state.json
    mcp.json
    memory.sqlite
```

### 8.1 建议承载内容

- 外部附加目录映射
- workspace 内部状态
- MCP 配置
- memory sqlite 数据库
- 其他明确属于内部索引/状态的文件

### 8.2 原则

- `.meta/` 不承载用户主语义
- 用户不需要通过 `.meta/` 理解 workspace 是什么
- 未来新增内部配置优先放 `.meta/`

## 9. UI 语义与磁盘路径映射

### 9.1 当前任务文件

UI：
- `当前任务文件`

磁盘：

```text
workspace/threads/<thread-id>/files/
```

说明：
- UI 用“任务”描述用户心智
- 磁盘用 `thread` 描述系统真实对象
- 这是允许的稳定映射

### 9.2 工作区共享文件

UI：
- `工作区共享文件`

磁盘：

```text
workspace/resources/
```

说明：
- UI 与磁盘名字应尽量直通

### 9.3 外部附加目录

UI：
- `外部附加目录`

磁盘：
- 不映射到一个真实内容目录
- 仅映射到 `.meta/` 中的挂载关系记录

说明：
- 它不是正式工作区资产
- 它只是临时上下文挂载

### 9.4 任务计划

UI：
- `任务计划`

磁盘：

```text
workspace/threads/<thread-id>/plans/
```

### 9.5 任务产物

UI：
- `任务产物`

磁盘：

```text
workspace/threads/<thread-id>/artifacts/
```

## 10. 当前已明确的保留/删除决策

### 10.1 保留

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`（但必须非常短）
- `IDENTITY.md`
- `USER.md`
- `MEMORY.md`
- `HEARTBEAT.md`
- `threads/<thread-id>/.context/`

### 10.2 删除

- `BOOTSTRAP.md`
- `threads/<thread-id>/.claude/`
- `threads/<thread-id>/.note`
- 旧 thread 根混放模式

## 11. 迁移原则

本设计先定义目标结构，不要求在同一轮实现中完成所有迁移。

迁移时应遵循：

- 原 thread 根下的用户工作文件迁入 `files/`
- 计划相关内容迁入 `plans/`
- 结果物迁入 `artifacts/`
- `.context/` 保留
- 内部状态与配置逐步下沉到 `.meta/`

## 12. 非目标

本设计不直接覆盖以下问题：

- UI 侧如何展示推荐提升卡片
- 任务完成后候选文件的筛选算法
- Chat 模式独立文件模型
- 所有历史 workspace 的自动迁移脚本细节

## 13. 成功标准

若该设计实施完成，应满足：

- workspace 根目录本身可读、可理解
- `resources/`、`threads/`、`.meta/` 三者边界稳定
- thread 根目录不再继续混放工作文件与系统辅助目录
- 一次性和噪音型文件被删除
- UI 中的三层语义能稳定映射到真实磁盘结构
