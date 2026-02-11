"use client";

import { useAtomValue } from "jotai";
import { currentAgentSessionAtom } from "@/atoms";

export function AgentHeader(): React.ReactElement | null {
  const session = useAtomValue(currentAgentSessionAtom);
  if (!session) return null;

  return (
    <div className="flex items-start justify-between gap-3">
      <div>
        <h2 className="text-2xl font-semibold">Agent</h2>
        <p className="text-sm text-muted-foreground">{session.title}</p>
      </div>
    </div>
  );
}
