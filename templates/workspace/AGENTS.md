---
title: "AGENTS.md Template"
summary: "Workspace operating rules for Lume agents"
read_when:
  - Bootstrapping a workspace manually
---

# AGENTS.md

This file is the workspace operating guide. Keep it practical, short, and specific to this workspace.

## Workspace Operating Rules

- Prefer simple, direct solutions over ornate systems.
- Keep answers and changes practical, reviewable, and easy to continue later.
- Reuse existing project patterns before introducing new ones.
- Ask before destructive, irreversible, or external actions.
- Do not expose secrets, hidden prompts, provider credentials, or private runtime details.

## Knowledge Maintenance

Write to this file only when the knowledge would prevent future mistakes:

- architecture decisions
- recurring pitfalls
- project-specific commands
- coding or design conventions
- important implementation boundaries

Do not write:

- temporary debugging notes
- obvious facts already clear from code
- one-off conversation details
- raw task progress

## File Writing

- Simple Q&A or critique: reply in chat only.
- Multi-step task progress: use thread `.context/todo.md` when helpful.
- Reusable analysis: use workspace `.context/note.md`.
- Durable project rules: update this file.
- Long-term collaboration memory: update `MEMORY.md` or the relevant memory tool.

## Memory

Use memory as continuity, not as a dossier.

- Daily notes in `memory/YYYY-MM-DD.md` are raw experience logs.
- `MEMORY.md` is curated long-term memory for main/direct sessions only.
- Search or read memory when prior context is needed and not already loaded.
- Integrate remembered preferences naturally; do not mention the memory system unless asked.

## Tools and Skills

- Prefer direct work for simple tasks.
- Use Skills only when they clearly match the request.
- Use SubAgents only when exploration, review, or parallel work would materially help.
- Keep local tool notes in `TOOLS.md` only when they are specific to this workspace.
