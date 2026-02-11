"use client";

import { useEffect, useRef, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { conversationsAtom, currentConversationAtom, selectedModelAtom } from "@/atoms";
import { updateConversationTitle } from "@/lib/desktop-api";
import type { ModelOption } from "@lume/shared";

interface ChatHeaderProps {
  modelOptions: ModelOption[];
  onModelChange: (value: { channelId: string; modelId: string } | null) => void;
}

export function ChatHeader({ modelOptions, onModelChange }: ChatHeaderProps): React.ReactElement | null {
  const conversation = useAtomValue(currentConversationAtom);
  const selectedModel = useAtomValue(selectedModelAtom);
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

  const selectedValue = selectedModel
    ? `${selectedModel.channelId}::${selectedModel.modelId}`
    : "";

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
    <div className="flex items-start justify-between gap-3">
      <div>
        <h2 className="text-2xl font-semibold">Chat</h2>
        {editing ? (
          <input
            ref={inputRef}
            value={titleDraft}
            className="mt-1 h-8 min-w-[220px] rounded-md border border-slate-700 bg-slate-950 px-2 text-sm text-slate-200 outline-none focus:border-cyan-400"
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
        ) : (
            <p
              role="button"
              tabIndex={0}
              className="cursor-pointer text-sm text-muted-foreground"
              onClick={() => {
              setTitleDraft(conversation.title);
              setEditing(true);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                setTitleDraft(conversation.title);
                setEditing(true);
              }
            }}
          >
            {conversation.title}
          </p>
        )}
      </div>
      <select
        className="h-9 min-w-[220px] rounded-md border border-slate-700 bg-slate-950 px-3 text-sm text-slate-200 outline-none focus:border-cyan-400"
        value={selectedValue}
        onChange={(event) => {
          const value = event.target.value;
          if (!value) {
            onModelChange(null);
            return;
          }
          const [channelId, modelId] = value.split("::");
          if (!channelId || !modelId) {
            onModelChange(null);
            return;
          }
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
    </div>
  );
}
