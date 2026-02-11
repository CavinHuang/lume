"use client";

import type { ChatMessage } from "@lume/shared";
import { AIMessage } from "@/components/ai-elements";

type ChatMessageItemProps = {
  message: ChatMessage;
  onDelete?: (messageId: string) => void;
};

export function ChatMessageItem({ message, onDelete }: ChatMessageItemProps): React.ReactElement {
  return (
    <div className={message.role === "user" ? "flex flex-col gap-1 rounded-xl border border-teal-400/40 bg-teal-700/20 px-3 py-2.5" : "flex flex-col gap-1 rounded-xl border border-slate-700 bg-slate-800/60 px-3 py-2.5"}>
      <div className="flex items-center justify-between gap-2">
        <strong>{message.role === "user" ? "You" : "AI"}</strong>
        {onDelete ? (
          <button type="button" className="rounded-md border border-red-900 bg-red-950/30 px-2 py-0.5 text-xs text-red-300 hover:bg-red-900/40" onClick={() => onDelete(message.id)}>
            Delete
          </button>
        ) : null}
      </div>
      <AIMessage content={message.content} />
    </div>
  );
}
