# Lume V1 规划：Tauri + Bun Workspace + Claude Agent SDK 桌面 Agent（Chat/Agent 双模式）

## 简要总结
目标是交付一个 **macOS 优先** 的桌面应用，支持 **通用对话（Chat）** 与 **工具执行（Agent）** 两种模式切换。  
技术基线为：`Tauri 2 + Next.js(静态导出 CSR) + Tailwind + shadcn/ui + Bun Workspace + Bun Sidecar + @anthropic-ai/claude-agent-sdk + SQLite`。  
核心能力包括：多任务并行执行、工具权限确认、Web 检索（可插拔，默认 Tavily）、本地加密密钥存储、白名单工作空间、自动更新、仅本地日志。

## 已确认的产品与约束
1. 模式：`Chat / Agent` 双模式。
2. Agent 形态：单 Agent 内核，支持 persona 配置切换。
3. 模型接入：通过本地中间服务（Tauri Sidecar）访问 Anthropic。
4. Sidecar runtime：`Bun + TypeScript`。
5. 存储：`SQLite` 本地数据库。
6. 执行：支持并行多任务。
7. 权限：高风险操作默认“每次确认”。
8. 文件访问：白名单目录 + “工作空间”概念。
9. 联网检索：可插拔 provider，默认 Tavily。
10. UI：中文优先。
11. 前端运行：Next.js 静态导出 + CSR。
12. 发布：V1 必须支持自动更新。
13. 日志：仅本地日志（无默认远程上报）。
14. 密钥：本地加密文件（后续可升级 Keychain）。

## 系统架构（决策完成）
1. `apps/desktop`：Tauri 壳层（Rust）+ 前端资源加载 + IPC 网关 + updater。
2. `apps/web`：Next.js 前端（`output: export`）+ Tailwind + shadcn/ui。
3. `apps/sidecar`：Bun 进程，负责 Agent 编排、工具调用、Web 检索、任务调度、SQLite 访问。
4. `packages/shared`：跨端类型、事件协议、Zod schema、错误码。
5. `packages/ui`（可选）：复用 UI 组件与主题 token。
6. 通信链路：`Next UI -> Tauri invoke/event -> Sidecar RPC(stdio/json)`。
7. 并行任务：Sidecar 内建任务管理器（任务状态机 + 并发上限 + 取消机制 + 资源锁）。

## 工作空间与权限模型
1. `Workspace` 为一级实体，包含：
   - `id, name, root_paths[], created_at, updated_at`
2. Agent 文件访问默认仅在 `workspace.root_paths` 内。
3. 跨白名单访问需弹窗确认（一次性 token，短时有效）。
4. 命令执行分级：
   - `safe`（读操作/低风险）  
   - `elevated`（写文件、安装依赖、删除等）必须每次确认。
5. 权限审计写入本地 `permission_audit` 表。

## 公共 API / 接口 / 类型变更（首版定义）
1. Tauri `invoke` 命令（前端 -> 桌面）：
   - `session.create(workspaceId, mode, personaId?) -> sessionId`
   - `message.send(sessionId, content, attachments?) -> taskId`
   - `task.list(sessionId) -> Task[]`
   - `task.cancel(taskId) -> void`
   - `workspace.list/create/update/delete`
   - `workspace.authorizePath(path) -> authorizationToken`
   - `settings.get/set`
2. 事件流（桌面 -> 前端）：
   - `task.updated`
   - `message.delta`
   - `tool.requested_confirmation`
   - `tool.execution_result`
   - `error.raised`
3. Sidecar RPC（桌面 -> Sidecar）：
   - `agent.runTask`
   - `agent.cancelTask`
   - `tool.execute`
   - `search.query`
   - `storage.*`
4. 核心类型（`packages/shared`）：
   - `AppMode = "chat" | "agent"`
   - `TaskStatus = "queued" | "running" | "blocked_confirmation" | "completed" | "failed" | "cancelled"`
   - `PermissionDecision = "allow_once" | "deny"`
   - `ToolCall`, `ToolResult`, `MessageChunk`, `WorkspacePolicy`
5. 错误码规范：
   - `E_AUTH`, `E_PERMISSION`, `E_OUT_OF_SCOPE_PATH`, `E_PROVIDER_UNAVAILABLE`, `E_RATE_LIMIT`, `E_INTERNAL`

## 数据模型（SQLite）
1. `workspaces`
2. `sessions`
3. `messages`
4. `tasks`
5. `task_events`
6. `tool_calls`
7. `permission_audit`
8. `settings`
9. `secrets_meta`（仅元信息，不存明文 key）

## 前端信息架构（UI）
1. 左侧：工作空间切换 + 会话列表 + 模式切换（Chat/Agent）。
2. 中区：消息流（流式输出）+ 任务时间线。
3. 右侧抽屉：任务详情、工具调用、权限确认面板。
4. 顶部：当前 workspace、并发任务计数、模型/provider 状态。
5. 首版 shadcn 组件优先：`Dialog`, `Sheet`, `Tabs`, `Command`, `Toast`, `Progress`, `Badge`, `Table`。

## 任务调度与并发策略
1. 默认并发上限：`2`（可配置，范围 1-4）。
2. 同一 workspace 的写操作工具加互斥锁，避免冲突写。
3. 长任务可取消，取消采用协作式中断（状态置为 `cancelled`）。
4. 失败重试仅针对可重试外部调用（网络检索/模型请求），默认最多 2 次指数退避。

## 安全与密钥方案
1. API Key 存储：本地加密文件（`age`/`libsodium` 方案二选一，推荐 `libsodium sealed box`）。
2. 加密主密钥来源：设备绑定 + 用户口令派生（PBKDF2/Argon2id，推荐 Argon2id）。
3. 密钥仅在 Sidecar 内存解密，前端不可直接读取。
4. 后续升级路径：抽象 `SecretStore` 接口，可切换 macOS Keychain 实现。

## 自动更新方案（必须）
1. 使用 Tauri Updater（签名发布）。
2. 渠道：`stable`（V1），预留 `beta`。
3. 启动检查 + 手动触发检查。
4. 更新失败回退到当前版本，不中断主流程。
5. 发布流水线包含签名、产物哈希、更新 manifest 生成。

## 测试与验收场景
1. 单元测试：
   - 类型/协议 schema 校验
   - 任务状态机转换
   - 权限判定与路径越界拦截
   - SecretStore 加解密正确性
2. 集成测试：
   - UI -> Tauri -> Sidecar 全链路消息流
   - 并行任务执行与互斥锁冲突处理
   - 工具确认弹窗批准/拒绝分支
   - Web 检索 provider 超时与降级
3. 端到端（macOS）：
   - 新建 workspace -> 发起 Agent 任务 -> 文件写入确认 -> 完成
   - 更新检查 -> 下载 -> 应用更新成功
   - 离线状态下应用可用（仅禁用检索）
4. 验收标准：
   - 首屏可用时间 < 3s（冷启动）
   - 普通对话首 token < 2.5s（网络正常）
   - 高风险工具 100% 走确认流
   - 越界路径访问 100% 拦截并审计

## 实施里程碑（建议 6 周）
1. 第 1 周：workspace 脚手架、shared 协议、Tauri<->Sidecar 基础通信。
2. 第 2 周：Chat 模式（流式输出、会话持久化）。
3. 第 3 周：Agent 模式（工具系统、权限确认、任务状态机）。
4. 第 4 周：并行调度、workspace 白名单、检索 provider 接入。
5. 第 5 周：安全加密存储、错误恢复、UI 打磨。
6. 第 6 周：自动更新、E2E、打包发布。

## 明确假设与默认值
1. 默认模型由中间服务配置，不在前端暴露复杂参数。
2. 默认并发上限 = 2，可在设置页调整。
3. 默认检索 provider = Tavily，可在配置中替换。
4. 默认日志仅本地落盘，保留“导出日志”能力。
5. 默认语言为中文，i18n 框架先接入但仅提供 `zh-CN` 资源。
6. 当前仓库为空目录，将从零初始化 monorepo 与应用脚手架。
