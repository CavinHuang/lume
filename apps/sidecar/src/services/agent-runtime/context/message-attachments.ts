import type { AgentMessageAttachmentInput } from "@lume/shared";

export function buildMessageAttachmentBrief(attachments?: AgentMessageAttachmentInput[]): string {
  if (!attachments?.length) return "";
  const isImage = (item: AgentMessageAttachmentInput) => item.mediaType.toLowerCase().startsWith("image/");
  const lines = attachments.map((item) => {
    const head = `- ${item.filename} (${item.mediaType}, ${formatBytes(item.size)})`;
    // 图片已作为 image block 直接随消息发送给视觉模型；不附带路径、也不引导走文件读取工具（见 #14）
    return isImage(item) ? head : `${head}: ${item.threadPath}`;
  });
  const hasFile = attachments.some((item) => !isImage(item));
  return [
    "本轮用户附加了以下附件：",
    ...lines,
    ...(hasFile ? ["", "请优先根据用户问题解读这些附件。需要更多细节时，使用文件读取工具访问对应路径。"] : []),
  ].join("\n");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  return `${Math.round(kb / 1024)} MB`;
}
