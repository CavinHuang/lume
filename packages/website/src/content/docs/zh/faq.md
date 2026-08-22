---
title: 常见问题
description: 关于数据、模型、平台与开源的常见疑问。
lang: zh
order: 5
---

## 我的数据存在哪里？

全部在你本机的 `~/.lume/` 目录：记忆是对可直接读写的 Markdown 文件，对话与配置同样是本地明文。没有云端账户，没有隐性上传。

## 支持哪些模型？

任何 OpenAI 兼容接口的模型都可以接入——OpenAI、Anthropic、Gemini、DeepSeek、GLM、通义、豆包、Moonshot 等，并可按任务分配不同模型。

## 支持哪些平台？

Windows 与 macOS 提供安装包，Linux 安装包在制作中。详见[下载页](../../download/)。

## 收费吗？

Lume 是 MIT 许可的开源软件，免费使用。模型调用费用取决于你自己的 API 账户。

## 记忆可以导出吗？

记忆本身就是 `~/.lume/memories/` 下的 Markdown 文件，随时可复制、grep、纳入 git 或同步到你的网盘——不需要专门的「导出」功能。

## 如何参与贡献？

欢迎 Issue 与 PR：[github.com/CavinHuang/lume](https://github.com/CavinHuang/lume)。提交前请阅读仓库内的 AGENTS.md 了解工作协议。
