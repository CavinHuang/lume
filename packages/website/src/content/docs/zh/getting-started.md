---
title: 快速开始
description: 下载安装 Lume，配置模型，跑起第一条工作流。
lang: zh
order: 1
---

## 安装

前往[下载页](/download/)获取最新安装包：

- **Windows**：下载 `.exe` 安装程序，按向导完成安装。
- **macOS**：根据芯片选择 Apple Silicon 或 Intel 版 `.dmg`，打开后将 Lume 拖入「应用程序」。

> 想从源码构建？克隆仓库后执行 `bun install && bun build:desktop`，需要 Node.js ≥ 20、Bun ≥ 1.0，构建桌面 native 能力另需 Rust stable。

## 首次启动

Lume 是本地应用：启动后所有数据都存放在你电脑的 `~/.lume/` 目录下——记忆、对话、项目上下文、技能配置，全部是可直接读写的本地文件。

## 配置模型

全局配置入口是 `~/.lume/lume.yaml`：

```yaml
models:
  default: openai/gpt-4o
```

Lume 通过 OpenAI 兼容接口接入主流模型（OpenAI、Anthropic、Gemini、DeepSeek、GLM、通义、豆包、Moonshot 等），也可以直接在对话输入框下方的模型选择器里切换。

## 建立工作区

把项目目录挂进 Lume，Agent 就能读写代码、执行命令：

```yaml
workspaces:
  my-project:
    path: ~/projects/my-project
    context: .context/
```

## 开始使用

新建会话，描述你想完成的任务即可。主线程会理解任务、调用工具、必要时分发给角色团队中更合适的人；你随时可以打断、补充或接管。
