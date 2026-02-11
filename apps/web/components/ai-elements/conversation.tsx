"use client";

import type { ChatMessage } from "@lume/shared";
import { AIMessage } from "./message";

type ConversationProps = {
  messages: ChatMessage[];
};

export function Conversation({ messages }: ConversationProps): React.ReactElement {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto pr-0.5">
      {messages.map((message) => (
        <div
          key={message.id}
          className={
            message.role === "user"
              ? "flex flex-col gap-1 rounded-xl border border-teal-400/40 bg-teal-700/20 px-3 py-2.5"
              : "flex flex-col gap-1 rounded-xl border border-slate-700 bg-slate-800/60 px-3 py-2.5"
          }
        >
          <strong>{message.role === "user" ? "You" : "AI"}</strong>
          <AIMessage content={message.content} />
        </div>
      ))}
    </div>
  );
}
