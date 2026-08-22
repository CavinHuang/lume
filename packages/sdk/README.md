# Open Agent SDK (TypeScript)

[![npm version](https://img.shields.io/npm/v/@codeany/open-agent-sdk)](https://www.npmjs.com/package/@codeany/open-agent-sdk)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

Open-source Agent SDK that runs the full agent loop **in-process** — no subprocess or CLI required. Deploy anywhere: cloud, serverless, Docker, CI/CD. The runtime is fully in-process; it does not depend on the Claude Code CLI.

Also available in **Go**: [open-agent-sdk-go](https://github.com/codeany-ai/open-agent-sdk-go)

## Get started

The SDK does not ship built-in HTTP providers. The host injects an `LLMProvider` implementation (see `providers/types.ts` for the contract — `createMessage()` plus optional `createMessageStream()`):

```typescript
import { createAgent, type LLMProvider } from "@lume/agent-sdk";

const myProvider: LLMProvider = {
  apiType: "anthropic-messages",
  async createMessage(params) {
    // Call your LLM endpoint and map the response to the normalized shape
    // { content, stopReason, usage: { input_tokens, output_tokens } }
    throw new Error("not implemented");
  },
};

const agent = createAgent({ provider: myProvider, model: "claude-sonnet-4-6" });
```

## Quick start

### One-shot query (streaming + control methods)

Requires a host-injected `provider` (see [Get started](#get-started)); omitted here for brevity.

```typescript
import { query } from "@codeany/open-agent-sdk";

const run = query({
  prompt: "Read package.json and tell me the project name.",
  options: {
    allowedTools: ["Read", "Glob"], // pre-approve these tools
    permissionMode: "bypassPermissions",
  },
});

for await (const message of run) {
  if (message.type === "assistant") {
    for (const block of message.message.content) {
      if ("text" in block) console.log(block.text);
    }
  }
}

const usage = await run.getContextUsage();
console.log(usage.totalTokens);
```

### Simple blocking prompt

```typescript
import { createAgent } from "@codeany/open-agent-sdk";

const agent = createAgent({ provider: myProvider, model: "claude-sonnet-4-6" });
const result = await agent.prompt("What files are in this project?");

console.log(result.text);
console.log(
  `Turns: ${result.num_turns}, Tokens: ${result.usage.input_tokens + result.usage.output_tokens}`,
);
```

### OpenAI / GPT models

Use any model by injecting the matching host-provided `LLMProvider` (the `apiType` on the provider routes protocol handling); the `model` option selects the model ID.

### Multi-turn conversation

```typescript
import { createAgent } from "@codeany/open-agent-sdk";

const agent = createAgent({ provider: myProvider, maxTurns: 5 });

const r1 = await agent.prompt(
  'Create a file /tmp/hello.txt with "Hello World"',
);
console.log(r1.text);

const r2 = await agent.prompt("Read back the file you just created");
console.log(r2.text);

console.log(`Session messages: ${agent.getMessages().length}`);
```

### Custom tools (low-level)

```typescript
import {
  createAgent,
  getAllBaseTools,
  defineTool,
} from "@codeany/open-agent-sdk";

const calculator = defineTool({
  name: "Calculator",
  description: "Evaluate a math expression",
  inputSchema: {
    type: "object",
    properties: { expression: { type: "string" } },
    required: ["expression"],
  },
  isReadOnly: true,
  async call(input) {
    const result = Function(`'use strict'; return (${input.expression})`)();
    return `${input.expression} = ${result}`;
  },
});

const agent = createAgent({ tools: [...getAllBaseTools(), calculator] });
const r = await agent.prompt("Calculate 2**10 * 3");
console.log(r.text);
```

### Skills

Skills are reusable prompt templates that extend agent capabilities. Five bundled skills are included: `simplify`, `commit`, `review`, `debug`, `test`.

```typescript
import {
  createAgent,
  registerSkill,
  getAllSkills,
} from "@codeany/open-agent-sdk";

// Register a custom skill
registerSkill({
  name: "explain",
  description: "Explain a concept in simple terms",
  userInvocable: true,
  async getPrompt(args) {
    return [
      {
        type: "text",
        text: `Explain in simple terms: ${args || "Ask what to explain."}`,
      },
    ];
  },
});

console.log(`${getAllSkills().length} skills registered`);

// The model can invoke skills via the Skill tool
const agent = createAgent();
const result = await agent.prompt('Use the "explain" skill to explain git rebase');
console.log(result.text);
```

### Hooks (lifecycle events)

```typescript
import { createAgent, createHookRegistry } from "@codeany/open-agent-sdk";

const hooks = createHookRegistry({
  PreToolUse: [
    {
      handler: async (input) => {
        console.log(`About to use: ${input.toolName}`);
        // Return { block: true } to prevent tool execution
      },
    },
  ],
  PostToolUse: [
    {
      handler: async (input) => {
        console.log(`Tool ${input.toolName} completed`);
      },
    },
  ],
});
```

28 lifecycle events including `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Setup`, `SessionStart`, `SessionEnd`, `Stop`, `StopFailure`, `SubagentStart`, `SubagentStop`, `UserPromptSubmit`, `PermissionRequest`, `PermissionDenied`, `TaskCreated`, `TaskCompleted`, `ConfigChange`, `WorktreeCreate`, `WorktreeRemove`, `CwdChanged`, `FileChanged`, `Notification`, `PreCompact`, `PostCompact`, `TeammateIdle`, `Elicitation`, `ElicitationResult`, and `InstructionsLoaded`.

### Subagents

```typescript
import { query } from "@codeany/open-agent-sdk";

for await (const msg of query({
  prompt: "Use the code-reviewer agent to review src/index.ts",
  options: {
    agents: {
      "code-reviewer": {
        description: "Expert code reviewer",
        prompt: "Analyze code quality. Focus on security and performance.",
        tools: ["Read", "Glob", "Grep"],
      },
    },
  },
})) {
  if (msg.type === "result") console.log("Done");
}
```

### Permissions

```typescript
import { query } from "@codeany/open-agent-sdk";

// Read-only agent — can only analyze, not modify
for await (const msg of query({
  prompt: "Review the code in src/ for best practices.",
  options: {
    allowedTools: ["Read", "Glob", "Grep"],
    permissionMode: "dontAsk",
  },
})) {
  // ...
}
```

### Hosting and deployment

This SDK is designed for long-lived services, serverless handlers, CI jobs, and local apps. It runs the agent loop in-process and does not spawn or depend on the Claude Code CLI.

### Secure deployment note

The `sandbox` option currently provides application-level filesystem and network guards inside SDK tools. It is not equivalent to Claude Code's full sandbox runtime. In particular, it does not provide OS-level process isolation or the full managed-policy enforcement described in the official secure deployment docs.

### Plugin trust model

Plugins are **trusted code, not sandboxed content**. Understand the following before installing one:

- **In-process execution.** A plugin's JS entry module is loaded with `import()` inside the host process (`packages/sdk/src/plugins/loader.ts`). The entry module runs with the full capabilities of the host — filesystem, network, environment variables, and Node APIs. There is no process isolation, no worker boundary, and no sandbox around it.
- **Installation grants authority ahead of any gate.** The permission system (sensitive-capability approvals, permission hashes, tool allow/deny lists) governs *declared* capabilities such as command tools, MCP servers, and hooks. By the time any of those gates run, the entry module's code is already executing with host privileges.
- **Installing a plugin is equivalent to granting it the host's full permissions.** Supply-chain risk for an installed plugin equals full compromise of the application embedding this SDK. Only install plugins from sources you trust.

What the SDK does constrain:

- **Load roots.** Plugins only load from the working directory or explicitly configured `pluginRoots`; manifest-declared entry modules are held to the same boundary.
- **Re-review on change.** A plugin's permissions hash covers its declared permissions and capability configuration (command tools including env/metadata/args order, hooks/MCP/LSP config file contents). Changing any of them flips the plugin back to needs-review before it loads again.
- **Command tools.** These run out-of-process with a minimal default environment, an optional OS-level process sandbox, a timeout, and a 1 MiB output cap — unlike entry modules, they are not given host privileges by default.

## API reference

### Top-level functions

| Function                              | Description                                                    |
| ------------------------------------- | -------------------------------------------------------------- |
| `query({ prompt, options })`          | One-shot streaming query, returns a Query control object       |
| `createAgent(options)`                | Create a reusable agent with session persistence               |
| `defineTool(config)`                  | Low-level tool definition helper                               |
| `getAllBaseTools()`                   | Get all 35+ built-in tools                                     |
| `registerSkill(definition)`           | Register a custom skill                                        |
| `getAllSkills()`                       | Get all registered skills                                      |
| `createHookRegistry(config)`          | Create a hook registry for lifecycle events                    |
| `listSessions()`                      | List persisted sessions                                        |
| `forkSession(id)`                     | Fork a session for branching                                   |

### Agent methods

| Method                          | Description                                           |
| ------------------------------- | ----------------------------------------------------- |
| `agent.query(prompt)`           | Streaming query, returns a Query control object        |
| `agent.prompt(text)`            | Blocking query, returns `Promise<QueryResult>`        |
| `agent.getMessages()`           | Get conversation history                              |
| `agent.clear()`                 | Reset session                                         |
| `agent.interrupt()`             | Abort current query                                   |
| `agent.setModel(model)`         | Change model mid-session                              |
| `agent.setPermissionMode(mode)` | Change permission mode                                |
| `agent.getApiType()`            | Get current API type                                  |
| `agent.close()`                 | Close MCP connections, persist session                |

### Query control methods

`query({ ... })` and `agent.query(...)` return an async-iterable Query object.

| Method                           | Description                                           |
| -------------------------------- | ----------------------------------------------------- |
| `query[Symbol.asyncIterator]()`  | Stream SDK events                                     |
| `query.streamInput(input)`       | Push additional prompt input                          |
| `query.interrupt()`              | Interrupt the current turn                            |
| `query.setModel(model)`          | Change model mid-session                              |
| `query.setPermissionMode(mode)`  | Change permission mode                                |
| `query.setMaxThinkingTokens(n)`  | Adjust thinking token budget                          |
| `query.setCwd(cwd)`              | Change working directory                              |
| `query.getInitializationResult()`| Get supported commands, agents, models                |
| `query.getContextUsage()`        | Get context usage breakdown                           |
| `query.reloadPlugins()`          | Reload plugins from disk                              |
| `query.rewindFiles(messageId)`   | Rewind file changes captured since a user message     |
| `query.stopTask(taskId)`         | Stop a background task                                |

### Options

| Option               | Type                                    | Default                | Description                                                          |
| -------------------- | --------------------------------------- | ---------------------- | -------------------------------------------------------------------- |
| `provider`           | `LLMProvider`                           | —                      | Host-owned provider implementation. Required for any run — the SDK ships no built-in HTTP providers; protocol and credentials are not resolved by the SDK |
| `model`              | `string`                                | `claude-sonnet-4-6`    | LLM model ID                                                         |
| `cwd`                | `string`                                | `process.cwd()`        | Working directory                                                    |
| `systemPrompt`       | `string`                                | —                      | System prompt override                                               |
| `appendSystemPrompt` | `string`                                | —                      | Append to default system prompt                                      |
| `tools`              | `ToolDefinition[]`                      | All built-in           | Available tools                                                      |
| `allowedTools`       | `string[]`                              | —                      | Tool pre-approval rules; does not hide tools from model context      |
| `disallowedTools`    | `string[]`                              | —                      | Tool deny-list                                                       |
| `permissionMode`     | `string`                                | `bypassPermissions`    | `default` / `acceptEdits` / `dontAsk` / `bypassPermissions` / `plan` |
| `canUseTool`         | `function`                              | —                      | Custom permission callback                                           |
| `maxTurns`           | `number`                                | `10`                   | Max agentic turns                                                    |
| `maxBudgetUsd`       | `number`                                | —                      | Spending cap                                                         |
| `thinking`           | `ThinkingConfig`                        | `{ type: 'adaptive' }` | Extended thinking                                                    |
| `effort`             | `string`                                | `high`                 | Reasoning effort: `low` / `medium` / `high` / `max`                  |
| `agents`             | `Record<string, AgentDefinition>`       | —                      | Subagent definitions                                                 |
| `hooks`              | `Record<string, HookCallbackMatcher[]>` | —                      | Lifecycle hooks                                                      |
| `resume`             | `string`                                | —                      | Resume session by ID                                                 |
| `continue`           | `boolean`                               | `false`                | Continue most recent session                                         |
| `persistSession`     | `boolean`                               | `true`                 | Persist session to disk                                              |
| `sessionId`          | `string`                                | auto                   | Explicit session ID                                                  |
| `forkSession`        | `boolean`                               | `false`                | Fork instead of directly resuming a prior session                    |
| `enableFileCheckpointing` | `boolean`                          | `false`                | Capture editable file snapshots for `rewindFiles()`                  |
| `outputFormat`       | `{ type: 'json_schema', schema }`       | —                      | Structured output                                                    |
| `sandbox`            | `SandboxSettings`                       | —                      | Filesystem/network sandbox                                           |
| `settingSources`     | `SettingSource[]`                       | —                      | Load AGENT.md, project settings                                      |
| `plugins`            | `Array<{ name, path?, config? }>`       | —                      | Load local plugin modules or manifests                               |
| `promptSuggestions`  | `boolean`                               | `false`                | Emit `prompt_suggestion` events after turns                          |
| `env`                | `Record<string, string>`                | —                      | Environment variables                                                |
| `abortController`    | `AbortController`                       | —                      | Cancellation controller                                              |

### Environment variables

Credentials live in the injected provider, not the SDK. The remaining variable:

| Variable             | Description                                              |
| -------------------- | -------------------------------------------------------- |
| `CODEANY_MODEL`      | Default model override                                   |

## Built-in tools

| Tool                                       | Description                                  |
| ------------------------------------------ | -------------------------------------------- |
| **Bash**                                   | Execute shell commands                       |
| **Read**                                   | Read files with line numbers                 |
| **Write**                                  | Create / overwrite files                     |
| **Edit**                                   | Precise string replacement in files          |
| **Glob**                                   | Find files by pattern                        |
| **Grep**                                   | Search file contents with regex              |
| **WebFetch**                               | Fetch and parse web content                  |
| **WebSearch**                              | Search the web                               |
| **NotebookEdit**                           | Edit Jupyter notebook cells                  |
| **Agent**                                  | Spawn subagents for parallel work            |
| **Skill**                                  | Invoke registered skills                     |
| **TaskCreate/List/Update/Get/Stop/Output** | Task management system with background tasks |
| **TeamCreate/Delete**                      | Multi-agent team coordination                |
| **SendMessage**                            | Inter-agent messaging                        |
| **EnterWorktree/ExitWorktree**             | Git worktree isolation                       |
| **AskUserQuestion**                        | Structured multiple-choice user input        |
| **ToolSearch**                             | Discover lazy-loaded tools                   |
| **ListMcpResourcesTool/ReadMcpResourceTool** | MCP resource access                        |
| **SubscribeMcpResource/UnsubscribeMcpResource** | MCP resource subscriptions                |
| **SubscribePolling/UnsubscribePolling**    | MCP polling subscriptions                    |
| **McpAuth**                                | Start MCP authentication flows               |
| **CronCreate/Delete/List**                 | Scheduled task management                    |
| **RemoteTrigger**                          | Remote agent triggers                        |
| **Config**                                 | Get/set session config by setting key        |
| **TodoWrite**                              | Replace the session todo list                |

## Bundled skills

| Skill        | Description                                                    |
| ------------ | -------------------------------------------------------------- |
| `simplify`   | Review changed code for reuse, quality, and efficiency         |
| `commit`     | Create a git commit with a well-crafted message                |
| `review`     | Review code changes for correctness, security, and performance |
| `debug`      | Systematic debugging using structured investigation            |
| `test`       | Run tests and analyze failures                                 |

Register custom skills with `registerSkill()`.

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                   Your Application                    │
│                                                       │
│   import { createAgent } from '@codeany/open-agent-sdk' │
└────────────────────────┬─────────────────────────────┘
                         │
              ┌──────────▼──────────┐
              │       Agent         │  Session state, tool pool,
              │  query() / prompt() │  MCP connections, hooks
              └──────────┬──────────┘
                         │
              ┌──────────▼──────────┐
              │    QueryEngine      │  Agentic loop:
              │   submitMessage()   │  API call → tools → repeat
              └──────────┬──────────┘
                         │
         ┌───────────────┼───────────────┐
         │               │               │
   ┌─────▼─────┐  ┌─────▼─────┐  ┌─────▼─────┐
   │  Provider  │  │  35 Tools │  │    MCP     │
   │ Host-     │  │ Bash,Read │  │  Servers   │
   │ injected  │  │ Edit,...  │  │ stdio/SSE/ │
   │LLMProvider│  │ + Skills  │  │ HTTP/SDK   │
   └───────────┘  └───────────┘  └───────────┘
```

**Key internals:**

| Component             | Description                                                        |
| --------------------- | ------------------------------------------------------------------ |
| **Provider layer**    | Host-injected `LLMProvider` contract (`providers/types.ts`)        |
| **QueryEngine**       | Core agentic loop with auto-compact, retry, tool orchestration     |
| **Skill system**      | Reusable prompt templates with 5 bundled skills                    |
| **Hook system**       | 20 lifecycle events integrated into the engine                     |
| **Auto-compact**      | Summarizes conversation when context window fills up               |
| **Micro-compact**     | Truncates oversized tool results                                   |
| **Retry**             | Exponential backoff for rate limits and transient errors            |
| **Token estimation**  | Rough token counting with pricing for Claude, GPT, DeepSeek models |
| **File cache**        | LRU cache (100 entries, 25 MB) for file reads                      |
| **Session storage**   | Persist / resume / fork sessions on disk                           |
| **Context injection** | Git status + AGENT.md automatically injected into system prompt    |

## Star History

<a href="https://www.star-history.com/?repos=codeany-ai%2Fopen-agent-sdk-typescript&type=timeline&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/image?repos=codeany-ai/open-agent-sdk-typescript&type=timeline&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/image?repos=codeany-ai/open-agent-sdk-typescript&type=timeline&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/image?repos=codeany-ai/open-agent-sdk-typescript&type=timeline&legend=top-left" />
 </picture>
</a>

## License

MIT
