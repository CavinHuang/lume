"use client";

import type * as React from "react";
import { ChevronDown, ChevronRight, Pencil, Pin, PinOff, Trash2 } from "lucide-react";
import type { ConversationMeta } from "@lume/shared";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import type { DateGroup } from "./left-sidebar-conversations";

interface EditingTarget {
  id: string;
  type: "conversation" | "agent";
  draft: string;
}

interface ConversationSidebarSectionProps {
  pinnedExpanded: boolean;
  onTogglePinnedExpanded: () => void;
  pinnedConversations: ConversationMeta[];
  conversationGroups: Array<{ label: DateGroup; items: ConversationMeta[] }>;
  currentConversationId: string | null;
  streamingIds: Set<string>;
  editing: EditingTarget | null;
  inputRef: React.RefObject<HTMLInputElement | null>;
  hoveredId: string | null;
  onHoveredIdChange: (id: string | null) => void;
  onEditingDraftChange: (draft: string) => void;
  onSaveEdit: () => Promise<void>;
  onCancelEdit: () => void;
  onOpenConversation: (conversationId: string) => void;
  onBeginEditConversation: (item: ConversationMeta) => void;
  onRequestDeleteConversation: (conversationId: string) => void;
  onToggleConversationPinned: (conversationId: string) => Promise<void>;
  rowClass: (active: boolean) => string;
}

export function ConversationSidebarSection({
  pinnedExpanded,
  onTogglePinnedExpanded,
  pinnedConversations,
  conversationGroups,
  currentConversationId,
  streamingIds,
  editing,
  inputRef,
  hoveredId,
  onHoveredIdChange,
  onEditingDraftChange,
  onSaveEdit,
  onCancelEdit,
  onOpenConversation,
  onBeginEditConversation,
  onRequestDeleteConversation,
  onToggleConversationPinned,
  rowClass
}: ConversationSidebarSectionProps): React.ReactElement {
  const renderConversationRow = (item: ConversationMeta, hoverKey: string): React.ReactElement => (
    <ContextMenu key={hoverKey}>
      <ContextMenuTrigger asChild>
        <div
          role="button"
          tabIndex={0}
          className={rowClass(currentConversationId === item.id)}
          onClick={() => onOpenConversation(item.id)}
          onDoubleClick={() => onBeginEditConversation(item)}
          onMouseEnter={() => onHoveredIdChange(hoverKey)}
          onMouseLeave={() => onHoveredIdChange((hoveredId === hoverKey ? null : hoveredId))}
        >
          {streamingIds.has(item.id) ? (
            <span className="relative flex-shrink-0 size-2">
              <span className="absolute inset-0 rounded-full bg-green-500/60 animate-ping" />
              <span className="relative block size-2 rounded-full bg-green-500" />
            </span>
          ) : null}
          <div className="min-w-0 flex-1">
            {editing?.type === "conversation" && editing.id === item.id ? (
              <input
                ref={inputRef as React.RefObject<HTMLInputElement>}
                value={editing.draft}
                onChange={(event) => onEditingDraftChange(event.target.value)}
                onBlur={() => { void onSaveEdit(); }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void onSaveEdit();
                  }
                  if (event.key === "Escape") onCancelEdit();
                }}
                className="w-full border-b border-primary/50 bg-transparent text-[13px] outline-none"
              />
            ) : (
              <span className="truncate">{item.title}</span>
            )}
          </div>
          <button
            type="button"
            className={cn(
              "rounded-md p-1 text-foreground/30 transition-all hover:bg-destructive/10 hover:text-destructive",
              hoveredId === hoverKey && !(editing?.type === "conversation" && editing.id === item.id)
                ? "opacity-100"
                : "pointer-events-none opacity-0"
            )}
            onClick={(event) => {
              event.stopPropagation();
              onRequestDeleteConversation(item.id);
            }}
          >
            <Trash2 size={13} />
          </button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-40">
        <ContextMenuItem className="gap-2 text-[13px]" onSelect={() => { void onToggleConversationPinned(item.id); }}>
          {item.pinned ? <PinOff size={14} /> : <Pin size={14} />}
          {item.pinned ? "取消置顶" : "置顶对话"}
        </ContextMenuItem>
        <ContextMenuItem className="gap-2 text-[13px]" onSelect={() => onBeginEditConversation(item)}>
          <Pencil size={14} />重命名
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem className="gap-2 text-[13px] text-destructive focus:text-destructive" onSelect={() => onRequestDeleteConversation(item.id)}>
          <Trash2 size={14} />删除
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );

  return (
    <>
      <div className="px-3 pt-3">
        <button
          type="button"
          className="titlebar-no-drag flex w-full items-center justify-between rounded-[10px] px-3 py-2 text-[13px] text-foreground/70 transition-colors hover:bg-foreground/[0.04]"
          onClick={onTogglePinnedExpanded}
        >
          <span className="inline-flex items-center gap-2"><Pin size={14} />置顶对话</span>
          {pinnedConversations.length > 0 ? (pinnedExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />) : null}
        </button>
      </div>

      {pinnedExpanded && pinnedConversations.length > 0 ? (
        <div className="px-3 pb-1">
          <div className="ml-2 flex flex-col gap-0.5 border-l-2 border-primary/20 pl-1">
            {pinnedConversations.map((item) => renderConversationRow(item, `pin-${item.id}`))}
          </div>
        </div>
      ) : null}

      <div className="scrollbar-none flex-1 overflow-y-auto px-3 pt-2 pb-3">
        {conversationGroups.map((group) => (
          <div key={group.label} className="mb-1">
            <div className="select-none px-3 pt-2 pb-1 text-[11px] font-medium text-foreground/40">{group.label}</div>
            <div className="flex flex-col gap-0.5">
              {group.items.map((item) => renderConversationRow(item, item.id))}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
