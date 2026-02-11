"use client";

import type { ChatMessage } from "@lume/shared";
import { AIMessage, ReasoningBlock } from "@/components/ai-elements";

interface ChatMessagesProps {
  messages: ChatMessage[];
  contextDividers: string[];
  onDeleteMessage?: (messageId: string) => Promise<void>;
  onDeleteDivider?: (messageId: string) => void;
  streamingContent?: string;
}

export function ChatMessages({
  messages,
  contextDividers,
  onDeleteMessage,
  onDeleteDivider,
  streamingContent
}: ChatMessagesProps): React.ReactElement {
  const dividerSet = new Set(contextDividers);
  const messageClass = (isUser: boolean): string =>
    isUser
      ? "flex flex-col gap-1 rounded-xl border border-teal-400/40 bg-teal-700/20 px-3 py-2.5"
      : "flex flex-col gap-1 rounded-xl border border-slate-700 bg-slate-800/60 px-3 py-2.5";

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto pr-0.5">
      {messages.map((message) => (
        <div key={message.id}>
          <div className={messageClass(message.role === "user")}>
            <div className="flex items-center justify-between gap-2">
              <strong>{message.role === "user" ? "You" : "AI"}</strong>
              {onDeleteMessage ? (
                <button
                  type="button"
                  className="rounded-md border border-red-900 bg-red-950/30 px-2 py-0.5 text-xs text-red-300 transition-colors hover:bg-red-900/40"
                  onClick={() => { void onDeleteMessage(message.id); }}
                >
                  Delete
                </button>
              ) : null}
            </div>
            <AIMessage content={message.content} />
            {message.reasoning ? <ReasoningBlock content={message.reasoning} /> : null}
          </div>
          {dividerSet.has(message.id) ? (
            <div className="my-1 flex items-center gap-2">
              <span className="h-px flex-1 bg-slate-700" />
              <button
                type="button"
                className="rounded-full border border-dashed border-slate-700 bg-slate-950 px-2.5 py-0.5 text-xs text-slate-400"
                onClick={() => onDeleteDivider?.(message.id)}
              >
                Context Divider
              </button>
              <span className="h-px flex-1 bg-slate-700" />
            </div>
          ) : null}
        </div>
      ))}
      {streamingContent ? (
        <div className="flex flex-col gap-1 rounded-xl border border-dashed border-slate-600 bg-slate-800/60 px-3 py-2.5">
          <strong>AI</strong>
          <AIMessage content={streamingContent} />
        </div>
      ) : null}
    </div>
  );
}
