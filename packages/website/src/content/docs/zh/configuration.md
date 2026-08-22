---
title: 配置参考
description: lume.yaml 全局配置：模型、工作区与 MCP 服务器。
lang: zh
order: 3
---

全局配置入口：`~/.lume/lume.yaml`

```yaml
# 模型配置
models:
  default: openai/gpt-4o

# 工作区
workspaces:
  my-project:
    path: ~/projects/my-project
    context: .context/

# MCP 服务器
mcp:
  my-server:
    command: npx
    args: ["-y", "my-mcp-server"]
```

## models

`default` 指定默认模型，格式为 `provider/model`。模型通过 OpenAI 兼容接口接入，对话时可在输入框下方的选择器中临时切换。

## workspaces

每个工作区绑定一个本地目录：

- `path`：项目路径。
- `context`：项目上下文目录（相对路径），Agent 会从这里理解项目结构与约定。

## mcp

以 stdio 方式挂载 MCP 服务器：`command` 为启动命令，`args` 为参数列表。配置后其工具会自动出现在 Agent 的工具列表中。

## 数据目录

`~/.lume/` 下按用途分目录存放记忆、对话与配置，均为明文文件，随时可读可备份。
