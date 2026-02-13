---
name: claude-code-runner
description: "Run Claude Code (Anthropic) via the `claude` CLI in headless mode for codebase analysis, refactors, test fixing, and structured output. Use when the user asks to run Claude Code, use Plan Mode, auto-approve tools, generate JSON output, or integrate Claude Code into Lume workflows."
---

# Claude Code Runner (Lume)

Use the locally installed **Claude Code** CLI reliably in headless or interactive mode.

This skill supports two execution styles:
- **Headless mode** (non-interactive): best for normal prompts and structured output.
- **Interactive mode (tmux)**: required for **slash commands** like `/speckit.*` which can hang in headless mode.

## Quick checks

Verify installation:
```bash
claude --version
```

Run a minimal headless prompt:
```bash
./scripts/claude_code_run.py -p "Return only the single word OK."
```

## Core workflow

### 1) Run a headless prompt in a repo

```bash
cd /path/to/repo
./scripts/claude_code_run.py \
  -p "Summarize this project and point me to the key modules." \
  --permission-mode plan
```

### 2) Allow tools (auto-approve)

```bash
./scripts/claude_code_run.py \
  -p "Run the test suite and fix any failures." \
  --allowedTools "Bash,Read,Edit"
```

### 3) Get structured output

```bash
./scripts/claude_code_run.py \
  -p "Summarize this repo in 5 bullets." \
  --output-format json
```

### 4) Dispatch with auto-callback

```bash
./scripts/dispatch-claude-code.sh \
  -p "实现一个 Python 爬虫" \
  -n "my-scraper" \
  --permission-mode "bypassPermissions" \
  --workdir "/path/to/project"
```

## Task Dispatch & Auto-Callback

Use `dispatch-claude-code.sh` to run tasks with automatic result capture:

```bash
./scripts/dispatch-claude-code.sh \
  -p "Your task description" \
  -n "task-name" \
  -g "group-id" \
  --permission-mode "acceptEdits" \
  --allowed-tools "Bash,Read,Edit,Write" \
  --workdir "/path/to/project"
```

### Parameters

| 参数 | 说明 |
|------|------|
| `-p, --prompt` | 任务提示（必需）|
| `-n, --name` | 任务名称（用于跟踪）|
| `-g, --group` | 通知群组 ID（结果自动发送）|
| `-w, --workdir` | 工作目录 |
| `--agent-teams` | 启用 Agent Teams |
| `--teammate-mode` | Agent Teams 模式 (auto/in-process/tmux) |
| `--permission-mode` | 权限模式 |
| `--allowed-tools` | 允许的工具列表 |

## Hook Configuration

在 `~/.claude/settings.json` 中注册：

```json
{
  "hooks": {
    "Stop": [{"hooks": [{"type": "command", "command": "path/to/notify-lume.sh", "timeout": 10}]}],
    "SessionEnd": [{"hooks": [{"type": "command", "command": "path/to/notify-lume.sh", "timeout": 10}]}]
  }
}
```

## High-leverage Claude Code tips

### 1) Always give Claude a way to verify

Claude performs better when it can verify its work:
- "Fix the bug **and run tests**. Done when `npm test` passes."
- "Implement UI change, **take a screenshot** and compare."

### 2) Explore → Plan → Implement

For multi-step work, start in plan mode:
```bash
./scripts/claude_code_run.py -p "Analyze and propose a plan" --permission-mode plan
```

### 3) Manage context: /clear and /compact

- Use `/clear` between unrelated tasks.
- Use `/compact Focus on <X>` when nearing context limits.

### 4) Rewind with /rewind

If an approach is wrong, use `/rewind` to restore previous state.

### 5) Keep CLAUDE.md concise

Best practice for CLAUDE.md:
- build/test commands
- repo style rules
- environment quirks

### 6) Permissions: deny > ask > allow

Rules match in order: **deny first**, then ask, then allow.
Use deny rules to block secrets (e.g. `.env`, `secrets/**`).

## Interactive mode (tmux)

For slash commands, use interactive mode:

```bash
./scripts/claude_code_run.py \
  --mode interactive \
  --tmux-session cc-work \
  --permission-mode acceptEdits \
  --allowedTools "Bash,Read,Edit,Write" \
  -p "/some-slash-command"
```

Monitor with:
```bash
tmux -S /path/to/socket attach -t cc-work
```

## Notes

- **After correcting mistakes**: Always instruct Claude Code to update CLAUDE.md to avoid repeating errors.
- Claude Code sometimes expects a TTY; this wrapper uses `script(1)` to force a pseudo-terminal.
- Keep `--allowedTools` narrow (principle of least privilege).
