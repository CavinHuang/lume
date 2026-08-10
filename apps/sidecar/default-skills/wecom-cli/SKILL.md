---
name: "企业微信 IM 操作"
description: "通过 wecom_cli 工具操作企业微信:发消息、查通讯录、管理应用、读取素材等。wecom-cli 子命令参考。"
when_to_use: "当需要企业微信中发送消息、查询通讯录、管理应用、读取素材等操作时"
allowed_tools: ["wecom_cli"]
version: "1.0"
---

## 企业微信 CLI(wecom-cli)操作手册

通过 `wecom_cli` 工具执行企业微信 CLI 子命令。工具签名:`command`(子命令)+ `args`(参数数组)。

### 授权(首次必做)

企微 CLI 使用 `init` 命令初始化授权,用户须在 Lume IM 设置中完成。

- 检查状态:具体子命令以 `--help` 为准
- 发起授权:`command="init"`, `args=["--noninteractive", "--no-open"]`(返回登录 URL,用户浏览器打开)

未授权时工具结果会含 `guidance` 字段,提示去设置授权。

### 能力域

wecom-cli 能力域。**子命令可能随版本变化**,优先用 `command="<域>"`, `args=["--help"]` 动态确认参数:

| 能力域 | 典型用途 |
|--------|---------|
| message | 发送应用消息、工作通知 |
| contact | 查询通讯录、组织架构 |
| media | 上传 / 读取临时素材 |
| app | 应用管理 |

### 使用要点

1. 先确认授权状态;未授权时停止并提示用户去设置授权。
2. 不确定参数时,对目标子命令加 `--help` 探索,不要猜测参数。
3. 发消息等写操作是真实企业行为,确认目标接收人与内容后再执行。
4. 结果为结构化 JSON(`wecom_cli` 返回 stdout);解析失败时检查 `stderr` 与 `exitCode`。

> 注:企业微信 CLI license 待最终确认;授权方式以实际 `--help` 输出为准。
