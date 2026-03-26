"use client";

import type * as React from "react";
import { ArrowRightLeft, ChevronDown, ChevronRight, Pencil, Pin, PinOff, Trash2 } from "lucide-react";
import type { AgentSessionMeta, AgentWorkspace } from "@lume/shared";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import type { DateGroup } from "./left-sidebar-conversations";

interface EditingTarget {
  id: string;
  type: "conversation" | "agent";
  draft: string;
}

interface AgentSidebarSectionProps {
  agentPinnedExpanded: boolean;
  onTogglePinnedExpanded: () => void;
  pinnedAgentSessions: AgentSessionMeta[];
  agentGroups: Array<{ label: DateGroup; items: AgentSessionMeta[] }>;
  childSessionMap: Map<string, AgentSessionMeta[]>;
  expandedParentIds: Set<string>;
  onToggleParentExpanded: (parentId: string) => void;
  currentAgentSessionId: string | null;
  runningIds: Set<string>;
  agentWorkspaces: AgentWorkspace[];
  editing: EditingTarget | null;
  inputRef: React.RefObject<HTMLInputElement | null>;
  hoveredId: string | null;
  onHoveredIdChange: (id: string | null) => void;
  onEditingDraftChange: (draft: string) => void;
  onSaveEdit: () => Promise<void>;
  onCancelEdit: () => void;
  onOpenAgentSession: (sessionId: string) => void;
  onBeginEditAgent: (item: AgentSessionMeta) => void;
  onRequestDeleteAgent: (sessionId: string) => void;
  onToggleAgentPin: (sessionId: string) => Promise<void>;
  onMoveAgentSession: (sessionId: string, workspaceId: string) => Promise<void>;
  rowClass: (active: boolean) => string;
}

export function AgentSidebarSection({
  agentPinnedExpanded,
  onTogglePinnedExpanded,
  pinnedAgentSessions,
  agentGroups,
  childSessionMap,
  expandedParentIds,
  onToggleParentExpanded,
  currentAgentSessionId,
  runningIds,
  agentWorkspaces,
  editing,
  inputRef,
  hoveredId,
  onHoveredIdChange,
  onEditingDraftChange,
  onSaveEdit,
  onCancelEdit,
  onOpenAgentSession,
  onBeginEditAgent,
  onRequestDeleteAgent,
  onToggleAgentPin,
  onMoveAgentSession,
  rowClass
}: AgentSidebarSectionProps): React.ReactElement {
  const renderAgentRow = (item: AgentSessionMeta, hoverKey: string, childCount?: number, expanded?: boolean): React.ReactElement => (
    <ContextMenu key={hoverKey}>
      <ContextMenuTrigger asChild>
        <div
          role="button"
          tabIndex={0}
          className={rowClass(currentAgentSessionId === item.id)}
          onClick={() => onOpenAgentSession(item.id)}
          onDoubleClick={() => onBeginEditAgent(item)}
          onMouseEnter={() => onHoveredIdChange(hoverKey)}
          onMouseLeave={() => onHoveredIdChange((hoveredId === hoverKey ? null : hoveredId))}
        >
          {typeof childCount === "number" && childCount > 0 ? (
            <button
              type="button"
              className="shrink-0 rounded p-0.5 text-foreground/30 transition-colors hover:text-foreground/60"
              onClick={(event) => {
                event.stopPropagation();
                onToggleParentExpanded(item.id);
              }}
            >
              {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            </button>
          ) : null}
          {runningIds.has(item.id) ? (
            <span className="relative flex size-4 shrink-0 items-center justify-center">
              <span className="absolute size-2 rounded-full bg-blue-500/60 animate-ping" />
              <span className="relative block size-2 rounded-full bg-blue-500" />
            </span>
          ) : null}
          <div className="min-w-0 flex-1">
            {editing?.type === "agent" && editing.id === item.id ? (
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
          {typeof childCount === "number" && childCount > 0 ? (
            <span className="shrink-0 rounded-full bg-muted px-1.5 text-[10px] tabular-nums text-muted-foreground">
              {childCount}
            </span>
          ) : null}
          <button
            type="button"
            className={cn(
              "rounded-md p-1 text-foreground/30 transition-all hover:bg-destructive/10 hover:text-destructive",
              hoveredId === hoverKey && !(editing?.type === "agent" && editing.id === item.id)
                ? "opacity-100"
                : "pointer-events-none opacity-0"
            )}
            onClick={(event) => {
              event.stopPropagation();
              onRequestDeleteAgent(item.id);
            }}
          >
            <Trash2 size={13} />
          </button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-44">
        <ContextMenuItem className="gap-2 text-[13px]" onSelect={() => { void onToggleAgentPin(item.id); }}>
          {item.pinned ? <PinOff size={14} /> : <Pin size={14} />}
          {item.pinned ? "取消置顶" : "置顶会话"}
        </ContextMenuItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger className="gap-2 text-[13px]">
            <ArrowRightLeft size={14} />移动到工作区
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-44">
            {agentWorkspaces.filter((workspace) => workspace.id !== item.workspaceId).length === 0 ? (
              <ContextMenuItem disabled className="text-[13px]">
                无可用工作区
              </ContextMenuItem>
            ) : (
              agentWorkspaces
                .filter((workspace) => workspace.id !== item.workspaceId)
                .map((workspace) => (
                  <ContextMenuItem
                    key={`move-agent-${item.id}-${workspace.id}`}
                    className="text-[13px]"
                    onSelect={() => { void onMoveAgentSession(item.id, workspace.id); }}
                  >
                    {workspace.name}
                  </ContextMenuItem>
                ))
            )}
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuItem className="gap-2 text-[13px]" onSelect={() => onBeginEditAgent(item)}>
          <Pencil size={14} />重命名
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem className="gap-2 text-[13px] text-destructive focus:text-destructive" onSelect={() => onRequestDeleteAgent(item.id)}>
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
          <span className="inline-flex items-center gap-2"><Pin size={14} />置顶会话</span>
          {pinnedAgentSessions.length > 0 ? (agentPinnedExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />) : null}
        </button>
      </div>

      {agentPinnedExpanded && pinnedAgentSessions.length > 0 ? (
        <div className="px-3 pb-1">
          <div className="ml-2 flex flex-col gap-0.5 border-l-2 border-primary/20 pl-1">
            {pinnedAgentSessions.map((item) => renderAgentRow(item, `agent-pin-${item.id}`))}
          </div>
        </div>
      ) : null}

      <div className="scrollbar-none flex-1 overflow-y-auto px-3 pt-2 pb-3">
        {agentGroups.map((group) => (
          <div key={group.label} className="mb-1">
            <div className="select-none px-3 pt-2 pb-1 text-[11px] font-medium text-foreground/40">{group.label}</div>
            <div className="flex flex-col gap-0.5">
              {group.items.map((item) => {
                const children = childSessionMap.get(item.id);
                const hasChildren = !!children && children.length > 0;
                const isExpanded = expandedParentIds.has(item.id);
                return (
                  <div key={item.id}>
                    {renderAgentRow(item, item.id, children?.length, isExpanded)}
                    {hasChildren && isExpanded ? (
                      <div className="ml-4 flex flex-col gap-0.5 border-l-2 border-primary/20 pl-1">
                        {children.map((child) => (
                          <div
                            key={child.id}
                            role="button"
                            tabIndex={0}
                            className={rowClass(currentAgentSessionId === child.id)}
                            onClick={() => onOpenAgentSession(child.id)}
                            onMouseEnter={() => onHoveredIdChange(child.id)}
                            onMouseLeave={() => onHoveredIdChange((hoveredId === child.id ? null : hoveredId))}
                          >
                            {runningIds.has(child.id) ? (
                              <span className="relative flex size-4 shrink-0 items-center justify-center">
                                <span className="absolute size-2 rounded-full bg-blue-500/60 animate-ping" />
                                <span className="relative block size-2 rounded-full bg-blue-500" />
                              </span>
                            ) : null}
                            <span className="min-w-0 flex-1 truncate">{child.title}</span>
                            <button
                              type="button"
                              className={cn(
                                "rounded-md p-1 text-foreground/30 transition-all hover:bg-destructive/10 hover:text-destructive",
                                hoveredId === child.id ? "opacity-100" : "pointer-events-none opacity-0"
                              )}
                              onClick={(event) => {
                                event.stopPropagation();
                                onRequestDeleteAgent(child.id);
                              }}
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
