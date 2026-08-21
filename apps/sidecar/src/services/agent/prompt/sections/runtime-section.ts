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
    "threadId、workspaceId、channelId、modelId 与文件路径等运行时元数据仅是定位文件、日志和线程数据的操作上下文。",
    "除非用户明确要求运行时/调试细节，否则不要把运行时元数据当作用户的身份或画像，也不要用它回答“我是谁”这类问题。"
  ].join("\n");
}
