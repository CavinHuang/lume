"use client";

import { useEffect, useRef, useState } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { Check, Columns2, Pencil, Pin, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { conversationsAtom, currentConversationAtom, parallelModeAtom, selectedModelAtom } from "@/atoms/chat-atoms";
import { togglePinConversation, updateConversationTitle } from "@/lib/desktop-api";
import type { ModelOption } from "@lume/shared";

interface ChatHeaderProps {
  modelOptions: ModelOption[];
  onModelChange: (value: { channelId: string; modelId: string } | null) => void;
}

export function ChatHeader({ modelOptions, onModelChange }: ChatHeaderProps): React.ReactElement | null {
  const conversation = useAtomValue(currentConversationAtom);
  const selectedModel = useAtomValue(selectedModelAtom);
  const [parallelMode, setParallelMode] = useAtom(parallelModeAtom);
  const setConversations = useSetAtom(conversationsAtom);
  const [editing, setEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  if (!conversation) return null;

  const selectedValue = selectedModel ? `${selectedModel.channelId}::${selectedModel.modelId}` : "";

  const saveTitle = async (): Promise<void> => {
    const next = titleDraft.trim();
    if (!next || next === conversation.title) {
      setEditing(false);
      return;
    }
    const updated = await updateConversationTitle(conversation.id, next);
    setConversations((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
    setEditing(false);
  };

  return (
    <div className="relative z-[51] flex h-[48px] items-center gap-2 px-4 titlebar-no-drag">
      {editing ? (
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <input
            ref={inputRef}
            value={titleDraft}
            className="min-w-0 flex-1 border-b border-primary/50 bg-transparent px-0 py-0.5 text-sm font-medium outline-none"
            onChange={(event) => setTitleDraft(event.target.value)}
            onBlur={() => { void saveTitle(); }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void saveTitle();
              }
              if (event.key === "Escape") {
                setEditing(false);
              }
            }}
          />
          <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => { void saveTitle(); }} className="p-1 text-muted-foreground hover:text-foreground">
            <Check className="size-3.5" />
          </button>
          <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => setEditing(false)} className="p-1 text-muted-foreground hover:text-foreground">
            <X className="size-3.5" />
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="group flex min-w-0 flex-1 items-center gap-1.5 truncate text-sm font-medium text-foreground transition-colors hover:text-foreground/80"
          onClick={() => {
            setTitleDraft(conversation.title);
            setEditing(true);
          }}
        >
          <span className="truncate">{conversation.title}</span>
          <Pencil className="size-3 shrink-0 opacity-40 transition-opacity group-hover:opacity-70" />
        </button>
      )}

      <select
        className="h-8 min-w-[220px] rounded-md border border-border bg-background px-2.5 text-xs outline-none focus:border-primary/50"
        value={selectedValue}
        onChange={(event) => {
          const value = event.target.value;
          if (!value) return onModelChange(null);
          const [channelId, modelId] = value.split("::");
          if (!channelId || !modelId) return onModelChange(null);
          onModelChange({ channelId, modelId });
        }}
      >
        <option value="">选择模型</option>
        {modelOptions.map((option) => (
          <option key={`${option.channelId}::${option.modelId}`} value={`${option.channelId}::${option.modelId}`}>
            {option.channelName} / {option.modelName}
          </option>
        ))}
      </select>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn("h-8 w-8 shrink-0", conversation.pinned && "bg-accent text-accent-foreground")}
            onClick={() => {
              void togglePinConversation(conversation.id).then((updated) => {
                setConversations((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
              });
            }}
          >
            <Pin className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p>{conversation.pinned ? "取消置顶" : "置顶对话"}</p>
        </TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn("h-8 w-8 shrink-0", parallelMode && "bg-accent text-accent-foreground")}
            onClick={() => setParallelMode(!parallelMode)}
          >
            <Columns2 className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p>{parallelMode ? "关闭并排模式" : "并排模式"}</p>
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

