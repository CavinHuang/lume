import { validatePluginPath, validatePluginName, validateSemver } from "./manifest.js";

export const CODEX_EVENT_MAP: Record<string, string> = {
  PreToolUse: "PreToolUse",
  PostToolUse: "PostToolUse",
  PermissionRequest: "PermissionRequest",
  PreCompact: "PreCompact",
  PostCompact: "PostCompact",
  SessionStart: "SessionStart",
  UserPromptSubmit: "UserPromptSubmit",
  SubagentStart: "SubagentStart",
  SubagentStop: "SubagentStop",
  Stop: "Stop",
};

// Real built-in tool names: checkToolPermission is exact-match, so legacy
// aliases like FileWrite/FileEdit/AgentTool never matched anything (#316).
const CODEX_ALLOWED_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "TaskList",
  "TaskGet",
  "AskUserQuestion",
  "Config",
];

const CODEX_DENIED_TOOLS = [
  "Bash",
  "Write",
  "Edit",
  "NotebookEdit",
  "EnterWorktree",
  "ExitWorktree",
  "Agent",
  "SendMessage",
];

export function adaptCodexPlugin(
  codex: Record<string, unknown>,
  _pluginRoot: string,
): Record<string, unknown> {
  const name = codex.name as string;
  validatePluginName(name);
  const version = codex.version as string;
  validateSemver(version);

  // Validate paths
  const pathFields = ["skills", "hooks", "mcpServers"];
  for (const field of pathFields) {
    const raw = codex[field];
    if (typeof raw === "string") {
      validatePluginPath(raw, field);
    }
  }

  const iface = (codex.interface as Record<string, unknown>) ?? {};

  // Map skills: string → string[]
  const skills = typeof codex.skills === "string"
    ? [codex.skills as string]
    : Array.isArray(codex.skills)
      ? (codex.skills as string[])
      : undefined;

  return {
    schema: "lume-plugin/v1",
    name,
    version,
    description: codex.description as string | undefined,
    author: codex.author as string | undefined,
    displayName: (iface.displayName as string) ?? name,
    category: (iface.category as string) ?? undefined,
    skills,
    hooks: codex.hooks as string | undefined,
    mcpServers: codex.mcpServers as string | undefined,
    permissions: {
      filesystem: { read: ["./**"], write: ["./data/**"] },
      network: { outbound: [] },
      mcpServers: { register: true },
      shell: { allow: true },
      tools: {
        allow: [...CODEX_ALLOWED_TOOLS],
        deny: [...CODEX_DENIED_TOOLS],
      },
      hooks: { events: Object.keys(CODEX_EVENT_MAP) },
    },
    lume: { hooksOnly: false },
  };
}
