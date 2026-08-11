# 已有 OpenConnector 部署接入计划

## 目标

在不改变连接器业务 API 的前提下，让 Lume 可以选择本机内置 OpenConnector，或连接用户已有的 OpenConnector 部署。

## 范围

1. 桌面主进程负责保存运行模式、远程 origin 与可选 Admin/Runtime Token。
2. Token 使用现有主密钥加密保存，不进入 renderer 状态、日志或诊断结果。
3. 公网 origin 必须使用 HTTPS；仅 loopback 地址允许 HTTP。
4. Sidecar 只接受主进程下发的已校验 bootstrap，并把管理请求与 MCP 请求固定到同一 origin。
5. OAuth 待授权会话绑定发起时的 origin；运行时切换后不得恢复或轮询旧会话。
6. 本机模式继续由桌面进程启动、诊断和停止固定版本的 OpenConnector。

## 验证

- 远程配置加密保存并可在重启后恢复。
- 未鉴权部署、带 Token 部署和 bracketed IPv6 loopback 均通过边界测试。
- 健康检查只接受 OpenConnector 的结构化身份响应，并在总启动期限内中止停滞请求。
- 切换 origin 后，旧 OAuth 会话不再出现在可恢复列表，也不会向新部署轮询。
- Web、Sidecar 与 Desktop 类型检查通过。

## 风险与约束

- 远程连接器账户凭据由已有部署保存，界面不得声称其只保留在本机。
- 不支持带路径、查询参数、片段或 URL 内嵌凭据的 origin。
- 此能力独立于连接器目录 UI PR，便于单独审查、回滚和后续安全加固。
