import type { SessionType as ThreadType } from "@lume/shared";

type RuntimePromptMode = "full" | "minimal" | "none";

export function buildRuntimeSection(ctx: {
  promptMode: RuntimePromptMode;
  sessionType: ThreadType;
  chatType?: "direct" | "group" | "channel";
}): string {
  return [
    "## 运行时",
    `mode=${ctx.promptMode} | threadType=${ctx.sessionType} | chatType=${ctx.chatType ?? "direct"}`,
    "",
    "threadId、workspaceId、channelId 与文件路径仅用于定位文件、日志和线程数据；除非用户明确要求运行时/调试细节，不要把它们当作用户的身份或画像。"
  ].join("\n");
}
