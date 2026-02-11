"use client";

import { FormEvent, useState } from "react";
import { CornerDownLeft, Square } from "lucide-react";
import { Button } from "@/components/ui/button";

interface AgentInputProps {
  disabled?: boolean;
  onRun: (text: string) => Promise<void>;
  onStop: () => void;
}

export function AgentInput({ disabled, onRun, onStop }: AgentInputProps): React.ReactElement {
  const [draft, setDraft] = useState("");

  const canRun = !disabled && draft.trim().length > 0;

  const runNow = async (): Promise<void> => {
    if (!canRun) return;
    const content = draft.trim();
    setDraft("");
    await onRun(content);
  };

  const handleSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    await runNow();
  };

  return (
    <form className="px-2.5 pb-2.5 pt-2 md:px-[18px] md:pb-[18px]" onSubmit={handleSubmit}>
      <div className="rounded-[17px] border-[0.5px] border-border bg-background/70 pt-2 backdrop-blur-sm">
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="输入 Agent 指令..."
          rows={3}
          className="min-h-[90px] w-full resize-none bg-transparent px-4 py-2 text-sm outline-none placeholder:text-muted-foreground/50"
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void runNow();
            }
          }}
        />
        <div className="flex h-[40px] items-center justify-end gap-1.5 px-2 py-[5px]">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-[30px] rounded-full text-destructive hover:bg-destructive/10"
            onClick={onStop}
          >
            <Square className="size-[22px]" />
          </Button>
          <Button
            type="submit"
            variant="ghost"
            size="icon"
            className="size-[30px] rounded-full text-primary hover:bg-primary/10 disabled:cursor-not-allowed disabled:text-foreground/30"
            disabled={!canRun}
          >
            <CornerDownLeft className="size-[22px]" />
          </Button>
        </div>
      </div>
    </form>
  );
}
