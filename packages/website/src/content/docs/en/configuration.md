---
title: Configuration
description: The lume.yaml global config — models, workspaces and MCP servers.
lang: en
order: 3
---

Global config entry point: `~/.lume/lume.yaml`

```yaml
# Model config
models:
  default: openai/gpt-4o

# Workspaces
workspaces:
  my-project:
    path: ~/projects/my-project
    context: .context/

# MCP servers
mcp:
  my-server:
    command: npx
    args: ["-y", "my-mcp-server"]
```

## models

`default` sets the default model as `provider/model`. Models connect through an OpenAI-compatible API and can be switched per conversation via the picker below the input box.

## workspaces

Each workspace binds one local directory:

- `path`: the project path.
- `context`: project context directory (relative), where the agent reads structure and conventions.

## mcp

Mount MCP servers over stdio: `command` starts the server, `args` are its arguments. Their tools appear automatically in the agent's tool list.

## Data Directory

Under `~/.lume/`, memories, conversations and configs live in separate plain-text directories — readable and backup-able at any time.
