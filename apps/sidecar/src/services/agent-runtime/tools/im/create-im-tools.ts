import type { ToolDefinition } from "@lume/agent-sdk";
import type { ImThreadBinding } from "@lume/shared";
import { getImThreadBindingByThreadId } from "../../../im/im-thread-binding-store";
import { sendBoundImTextMessage } from "../../../im/im-send-service";
import { createSdkJsonResultTool } from "../sdk-tool-result";

export interface CreateImToolsInput {
  threadId: string;
  sendTextMessage?: (input: {
    binding: ImThreadBinding;
    text: string;
  }) => Promise<{ ok: true } | { ok: boolean }>;
}

function asText(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("text 必填");
  }
  return value.trim();
}

export function createSdkImTools(input: CreateImToolsInput): ToolDefinition[] {
  return [
    createSdkJsonResultTool({
      name: "send_im_message",
      description: "Send a text reply to the IM conversation bound to this Lume thread. The destination is fixed by the current thread binding and cannot be overridden.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", minLength: 1 }
        },
        required: ["text"]
      },
      async call(args) {
        const binding = getImThreadBindingByThreadId(input.threadId);
        if (!binding) {
          throw new Error("当前线程未绑定 IM 会话，无法发送。");
        }
        const text = asText(args.text);
        const sendTextMessage = input.sendTextMessage ?? sendBoundImTextMessage;
        await sendTextMessage({ binding, text });
        return {
          ok: true,
          provider: binding.provider,
          accountId: binding.accountId,
          peerKind: binding.peerKind,
          peerId: binding.peerId,
          warning: "已发送到绑定的 IM 会话；请勿在当前线程中声称已发送给其他联系人。"
        };
      }
    })
  ];
}
