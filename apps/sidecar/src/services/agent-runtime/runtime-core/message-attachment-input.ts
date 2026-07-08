import { readFileSync } from "node:fs";
import type { AgentMessageAttachmentInput } from "@lume/shared";
import type { ContentBlockParam } from "@lume/agent-sdk";
import { resolveThreadAttachmentPath } from "../../agent/agent-files-service";

export type RuntimeUserMessageInput = string | ContentBlockParam[];

export function buildRuntimeUserMessageInput(input: {
  userMessage: string;
  contentBlocks?: ContentBlockParam[];
  attachments?: AgentMessageAttachmentInput[];
  provider: string;
  workspaceSlug?: string;
  threadId: string;
}): RuntimeUserMessageInput {
  const extraBlocks = supportsImageContentBlocks(input.provider) ? input.contentBlocks ?? [] : [];
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
  provider: string;
  workspaceSlug?: string;
  threadId: string;
}): ContentBlockParam[] {
  if (!supportsImageContentBlocks(input.provider) || !input.workspaceSlug || !input.attachments?.length) {
    return [];
  }

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
    if (!data) {
      continue;
    }

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

function supportsImageContentBlocks(provider: string): boolean {
  const normalized = provider.trim().toLowerCase();
  return normalized === "anthropic" || normalized === "anthropic-compatible" || normalized === "openai";
}
