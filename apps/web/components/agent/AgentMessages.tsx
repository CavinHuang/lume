"use client";

import type { AgentMessage } from "@lume/shared";
import type { AgentStreamState } from "@/atoms";
import { ToolActivityTree } from "./ToolActivityItem";
import { AIMessage } from "@/components/ai-elements";

interface AgentMessagesProps {
  messages: AgentMessage[];
  streamState?: AgentStreamState;
}

export function AgentMessages({ messages, streamState }: AgentMessagesProps): React.ReactElement {
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
          <strong>{message.role.toUpperCase()}</strong>
          <AIMessage content={message.content} />
        </div>
      ))}

      {streamState?.toolActivities.length ? (
        <ToolActivityTree activities={streamState.toolActivities} />
      ) : null}

      {streamState?.content ? (
        <div className="flex flex-col gap-1 rounded-xl border border-dashed border-slate-600 bg-slate-800/60 px-3 py-2.5">
          <strong>ASSISTANT</strong>
          <AIMessage content={streamState.content} />
        </div>
      ) : null}
    </div>
  );
}
