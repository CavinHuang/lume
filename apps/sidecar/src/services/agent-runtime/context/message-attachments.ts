import type { AgentMessageAttachmentInput } from "@lume/shared";

export function buildMessageAttachmentBrief(attachments?: AgentMessageAttachmentInput[]): string {
  if (!attachments?.length) return "";
  const lines = attachments.map((item) =>
    `- ${item.filename} (${item.mediaType}, ${formatBytes(item.size)}): ${item.threadPath}`
  );
  return [
    "本轮用户附加了以下文件：",
    ...lines,
    "",
    "请优先根据用户问题解读这些附件。需要更多细节时，使用文件读取工具访问对应路径。"
  ].join("\n");
}

export function buildAttachedDirectoriesBrief(directories?: string[]): string {
  if (!directories?.length) return "";
  const lines = directories.map((dir) => `- ${dir}`);
  return [
    "本轮用户附加了以下目录，你可以直接使用文件读取工具访问其中的文件：",
    ...lines
  ].join("\n");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  return `${Math.round(kb / 1024)} MB`;
}
