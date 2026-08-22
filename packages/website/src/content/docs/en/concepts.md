---
title: Core Concepts
description: Workspaces, threads, memory, personas and Skills — Lume's mental model.
lang: en
order: 2
---

## Local Data

`~/.lume/` is the source of truth. Memories are Markdown files — cat them, grep them, back them up or migrate them freely. Vector indexes are just caches and can be rebuilt. Contradictory memories coexist visibly; you decide what wins, nothing is silently overwritten.

## Memory

Three scopes × six types:

| Scope | Range |
| --- | --- |
| global | personal facts and preferences across projects |
| workspace | conventions and decisions within one project |
| thread | context of a single conversation |

Types include fact, preference, decision, lesson, episode and milestone. Relevant memories are recalled naturally when a new conversation starts.

## Persona Team

Lume ships with 11 characters of distinct style and specialty — developer, writer, analyst, researcher, painter, designer and more. After understanding your task, the main thread routes subtasks to the best-fit persona.

## Skills & MCP

Each Skill is a `SKILL.md` prompt template with hot reloading — edits take effect immediately. Through the standard MCP client you can attach any external tool server to Lume.

## Toolset

The full toolset available to agents: file system (Read / Write / Edit / Glob / Grep), Bash (timeout control + background execution), LSP code intelligence, Office documents (create/edit docx / pptx / xlsx / pdf plus OOXML repair), web search & fetch, and image generation.

## Automation & IM

Cron jobs and daily schedules run on time and push results to the channel you choose. IM channels — WeChat, Feishu, DingTalk, WeCom — bind incoming messages to the matching workspace thread automatically.
