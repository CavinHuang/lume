import type { SessionType as ThreadType } from "@lume/shared";

type RuntimePromptMode = "full" | "minimal" | "none";

export function buildRuntimeSection(ctx: {
  promptMode: RuntimePromptMode;
  sessionType: ThreadType;
  chatType?: "direct" | "group" | "channel";
}): string {
  return [
    "## Runtime",
    `mode=${ctx.promptMode} | threadType=${ctx.sessionType} | chatType=${ctx.chatType ?? "direct"}`
  ].join("\n");
}
