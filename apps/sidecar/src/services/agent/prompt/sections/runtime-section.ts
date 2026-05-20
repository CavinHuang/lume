import type { SessionType as ThreadType } from "@lume/shared";

type RuntimePromptMode = "full" | "minimal" | "none";

export function buildRuntimeSection(ctx: {
  promptMode: RuntimePromptMode;
  sessionType: ThreadType;
  chatType?: "direct" | "group" | "channel";
}): string {
  return [
    "## Runtime",
    `mode=${ctx.promptMode} | threadType=${ctx.sessionType} | chatType=${ctx.chatType ?? "direct"}`,
    "",
    "Runtime metadata such as threadId, workspaceId, channelId, modelId, and file paths is operational context for locating files, logs, and thread data.",
    "Do not use or reveal runtime metadata as the user's identity, profile, or answer to questions like \"who am I\" unless the user explicitly asks for runtime/debug details."
  ].join("\n");
}
