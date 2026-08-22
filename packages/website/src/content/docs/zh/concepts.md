---
title: 核心概念
description: 工作区、线程、记忆、角色团队与 Skills——Lume 的基本心智模型。
lang: zh
order: 2
---

## 本地数据

一切以 `~/.lume/` 为真源。记忆是 Markdown 文件，可以 `cat`、可以 grep、可以备份迁移；向量索引只是缓存，删了也能重建。矛盾的记忆会并存展示，由你决定取舍，绝不静默覆盖。

## 记忆

三层作用域 × 六种类型：

| 作用域 | 范围 |
| --- | --- |
| global | 跨所有项目的个人偏好与事实 |
| workspace | 单个项目内的约定与决策 |
| thread | 单次对话的上下文 |

类型包括 fact（事实）、preference（偏好）、decision（决策）、lesson（教训）、episode（事件）与 milestone（里程碑）。新对话开始时，相关记忆自然召回。

## 角色团队

Lume 内置 11 位有独立风格与专长的角色——开发者、作家、分析师、调研员、画师、设计师等。主线程理解你的任务后，把子任务分发给最合适的角色执行。

## Skills 与 MCP

每个 Skill 是一个 `SKILL.md` 提示词模板，支持热加载，修改即生效。通过标准 MCP 客户端，你还可以把任意外部工具服务器挂进 Lume。

## 工具集

Agent 可用的完整工具：文件系统（Read / Write / Edit / Glob / Grep）、Bash（超时控制 + 后台执行）、Office 文档（docx / pptx / xlsx / pdf 的创建编辑与 OOXML 修复）、Web 搜索与抓取、图片生成。

## 自动化与 IM

cron 定时任务和每日日程到点自动执行，结果推送到你指定的渠道。微信、飞书、钉钉、企业微信等 IM 渠道接入后，消息会自动绑定到对应的工作区线程。
