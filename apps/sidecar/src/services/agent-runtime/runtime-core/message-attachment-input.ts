import { readFileSync } from "node:fs";
import type { AgentMessageAttachmentInput } from "@lume/shared";
import type { ContentBlockParam } from "@lume/agent-sdk";
import { resolveThreadAttachmentPath } from "../../agent/agent-files-service";

export type RuntimeUserMessageInput = string | ContentBlockParam[];

export function buildRuntimeUserMessageInput(input: {
  userMessage: string;
  contentBlocks?: ContentBlockParam[];
  attachments?: AgentMessageAttachmentInput[];
  workspaceSlug?: string;
  threadId: string;
}): RuntimeUserMessageInput {
  const extraBlocks = input.contentBlocks ?? [];
  const imageBlocks = buildImageAttachmentBlocks(input);
  if (!extraBlocks.length && !imageBlocks.length) {
    return input.userMessage;
  }

  const content: ContentBlockParam[] = [];
  if (input.userMessage.trim()) {
    content.push({ type: "text", text: input.userMessage });
  }
  content.push(...extraBlocks);
  content.push(...imageBlocks);
  return content;
}

function buildImageAttachmentBlocks(input: {
  attachments?: AgentMessageAttachmentInput[];
  workspaceSlug?: string;
  threadId: string;
}): ContentBlockParam[] {
  if (!input.attachments?.length) {
    return [];
  }
  if (!input.workspaceSlug) throw new Error("图片附件缺少工作区绑定，无法读取");

  const blocks: ContentBlockParam[] = [];
  for (const attachment of input.attachments) {
    if (!attachment.mediaType.toLowerCase().startsWith("image/")) {
      continue;
    }

    const data = readAttachmentBase64({
      workspaceSlug: input.workspaceSlug,
      threadId: input.threadId,
      threadPath: attachment.threadPath
    });
    if (!data) throw new Error(`图片附件不可读取：${attachment.filename}`);

    blocks.push({
      type: "image",
      source: {
        type: "base64",
        media_type: attachment.mediaType,
        data
      }
    });
  }
  return blocks;
}

function readAttachmentBase64(input: {
  workspaceSlug: string;
  threadId: string;
  threadPath: string;
}): string | null {
  try {
    const path = resolveThreadAttachmentPath(input.workspaceSlug, input.threadId, input.threadPath);
    return readFileSync(path).toString("base64");
  } catch {
    return null;
  }
}
