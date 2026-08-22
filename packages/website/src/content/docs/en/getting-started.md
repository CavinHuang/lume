---
title: Getting Started
description: Install Lume, configure a model, run your first workflow.
lang: en
order: 1
---

## Install

Grab the latest build from the [download page](../../download/):

- **Windows**: download the `.exe` installer and follow the wizard.
- **macOS**: pick the Apple Silicon or Intel `.dmg`, open it and drag Lume into Applications.

> Building from source? Clone the repo and run `bun install && bun build:desktop`. You need Node.js ≥ 20, Bun ≥ 1.0, and Rust stable for the desktop native modules.

## First Launch

Lume is a local app: once running, everything it knows lives under `~/.lume/` on your machine — memories, conversations, project context, skill configs — all plain files you can read and edit directly.

## Configure a Model

The global config entry point is `~/.lume/lume.yaml`:

```yaml
models:
  default: openai/gpt-4o
```

Lume connects to mainstream models (OpenAI, Anthropic, Gemini, DeepSeek, GLM, Qwen, Doubao, Moonshot…) through an OpenAI-compatible API; you can also switch models from the picker below the chat input.

## Create a Workspace

Attach a project directory so the agent can read code and run commands:

```yaml
workspaces:
  my-project:
    path: ~/projects/my-project
    context: .context/
```

## Start Using It

Open a new thread and describe what you want done. The main thread understands the task, calls tools, and hands subtasks to the best-fit persona when needed; you can interrupt, add context or take over at any time.
