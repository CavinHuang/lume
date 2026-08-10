---
name: "飞书企业 IM 操作"
description: "通过 feishu_cli 工具操作飞书:发消息、查日历、读文档、查通讯录、多维表格等。lark-cli 子命令参考。"
when_to_use: "当需要在飞书中发送消息、查询日历日程、读取飞书文档、查询通讯录/组织架构、管理多维表格等企业 IM 操作时"
allowed_tools: ["feishu_cli"]
version: "1.0"
---

## 飞书 CLI(lark-cli)操作手册

通过 `feishu_cli` 工具执行飞书 CLI 子命令。工具签名:`command`(子命令)+ `args`(参数数组)。

### 授权(首次必做)

飞书 CLI 使用 OAuth 授权,用户须在 Lume IM 设置中完成。

- 检查授权状态:`command="auth"`, `args=["status"]`
- 发起授权:`command="auth"`, `args=["login", "--recommend", "--json"]`(返回登录 URL,用户浏览器打开)

未授权时工具结果会含 `guidance` 字段,提示去设置授权。

### 能力域

lark-cli 覆盖飞书主要能力域(200+ 命令)。**子命令可能随版本变化**,优先用 `command="<域>"`, `args=["--help"]` 动态确认参数,不要猜测:

| 能力域 | 典型用途 |
|--------|---------|
| message / im | 发送消息、工作通知 |
| calendar | 查询、创建日历日程 |
| docx / drive | 读取飞书文档、云空间文件 |
| contact | 查询通讯录、组织架构、部门成员 |
| bitable | 多维表格读写 |
| approval | 审批流程 |

### 使用要点

1. 先 `auth status` 确认已授权;未授权时停止并提示用户去设置授权。
2. 不确定参数时,对目标子命令加 `--help` 探索,不要猜测参数。
3. 发消息等写操作是真实企业行为,确认目标接收人与内容后再执行。
4. 结果为结构化 JSON(`feishu_cli` 返回 stdout);解析失败时检查 `stderr` 与 `exitCode`。
