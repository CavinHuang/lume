"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { ChevronDown, ChevronRight, Pin, PinOff, Plus, Settings, Trash2, Pencil, Plug, Zap } from "lucide-react";
import type { AgentSessionMeta, ConversationMeta } from "@lume/shared";
import {
  activeViewAtom,
  agentRunningSessionIdsAtom,
  agentSessionsAtom,
  agentWorkspacesAtom,
  appModeAtom,
  conversationsAtom,
  currentAgentWorkspaceIdAtom,
  currentAgentSessionIdAtom,
  currentConversationIdAtom,
  hasUpdateAtom,
  selectedModelAtom,
  streamingConversationIdsAtom,
  workspaceCapabilitiesVersionAtom
} from "@/atoms";
import {
  createAgentSession,
  createConversation,
  deleteAgentSessionById,
  deleteConversationById,
  ensureDefaultAgentWorkspace,
  getAgentWorkspaceCapabilities,
  listAgentSessions,
  listAgentWorkspaces,
  listConversations,
  togglePinConversation,
  updateAgentSessionTitle,
  updateConversationTitle
} from "@/lib/desktop-api";
import { cn } from "@/lib/utils";
import { WorkspaceSelector } from "@/components/agent";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "@/components/ui/alert-dialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from "@/components/ui/context-menu";
import { ModeSwitcher } from "./ModeSwitcher";

type DateGroup = "今天" | "昨天" | "更早";
type DeleteTarget = { id: string; type: "conversation" | "agent" } | null;
type EditingTarget = { id: string; type: "conversation" | "agent"; draft: string } | null;
type CapabilityCounts = { mcp: number; skills: number } | null;

function groupByDate<T extends { updatedAt: number }>(items: T[]): Array<{ label: DateGroup; items: T[] }> {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterdayStart = todayStart - 86_400_000;
  const today: T[] = [];
  const yesterday: T[] = [];
  const earlier: T[] = [];

  for (const item of items) {
    if (item.updatedAt >= todayStart) today.push(item);
    else if (item.updatedAt >= yesterdayStart) yesterday.push(item);
    else earlier.push(item);
  }

  const groups: Array<{ label: DateGroup; items: T[] }> = [];
  if (today.length) groups.push({ label: "今天", items: today });
  if (yesterday.length) groups.push({ label: "昨天", items: yesterday });
  if (earlier.length) groups.push({ label: "更早", items: earlier });
  return groups;
}

export interface LeftSidebarProps {
  width?: number;
}

export function LeftSidebar({ width }: LeftSidebarProps): React.ReactElement {
  const mode = useAtomValue(appModeAtom);
  const [activeView, setActiveView] = useAtom(activeViewAtom);
  const hasUpdate = useAtomValue(hasUpdateAtom);
  const streamingIds = useAtomValue(streamingConversationIdsAtom);
  const runningIds = useAtomValue(agentRunningSessionIdsAtom);
  const selectedModel = useAtomValue(selectedModelAtom);
  const capabilitiesVersion = useAtomValue(workspaceCapabilitiesVersionAtom);

  const [conversations, setConversations] = useAtom(conversationsAtom);
  const [currentConversationId, setCurrentConversationId] = useAtom(currentConversationIdAtom);
  const [agentSessions, setAgentSessions] = useAtom(agentSessionsAtom);
  const [currentAgentSessionId, setCurrentAgentSessionId] = useAtom(currentAgentSessionIdAtom);
  const [agentWorkspaces, setAgentWorkspaces] = useAtom(agentWorkspacesAtom);
  const [currentWorkspaceId, setCurrentWorkspaceId] = useAtom(currentAgentWorkspaceIdAtom);

  const [pinnedExpanded, setPinnedExpanded] = useState(true);
  const [capabilities, setCapabilities] = useState<CapabilityCounts>(null);
  const [pendingDelete, setPendingDelete] = useState<DeleteTarget>(null);
  const [editing, setEditing] = useState<EditingTarget>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  useEffect(() => {
    void listConversations().then((items) => {
      setConversations(items);
      if (!currentConversationId && items[0]) setCurrentConversationId(items[0].id);
    });
    void listAgentSessions().then((items) => {
      setAgentSessions(items);
      if (!currentAgentSessionId && items[0]) setCurrentAgentSessionId(items[0].id);
    });
    void (async () => {
      await ensureDefaultAgentWorkspace();
      const ws = await listAgentWorkspaces();
      setAgentWorkspaces(ws);
      if (!currentWorkspaceId && ws[0]) setCurrentWorkspaceId(ws[0].id);
    })();
  }, [
    currentConversationId,
    currentAgentSessionId,
    currentWorkspaceId,
    setConversations,
    setCurrentConversationId,
    setAgentSessions,
    setCurrentAgentSessionId,
    setAgentWorkspaces,
    setCurrentWorkspaceId
  ]);

  useEffect(() => {
    if (mode !== "agent" || !currentWorkspaceId) {
      setCapabilities(null);
      return;
    }
    const ws = agentWorkspaces.find((item) => item.id === currentWorkspaceId);
    if (!ws) return;
    void getAgentWorkspaceCapabilities(ws.slug).then((caps) => {
      const enabledMcp = caps.mcpServers.filter((item) => item.enabled).length;
      setCapabilities({
        mcp: enabledMcp,
        skills: caps.skills.length
      });
    });
  }, [mode, currentWorkspaceId, agentWorkspaces, activeView, capabilitiesVersion]);

  const sortedConversations = useMemo(
    () => [...conversations].sort((a, b) => b.updatedAt - a.updatedAt),
    [conversations]
  );
  const pinnedConversations = useMemo(
    () => sortedConversations.filter((item) => item.pinned),
    [sortedConversations]
  );
  const conversationGroups = useMemo(
    () => groupByDate(sortedConversations),
    [sortedConversations]
  );

  const filteredAgentSessions = useMemo(
    () => [...agentSessions]
      .filter((item) => !currentWorkspaceId || item.workspaceId === currentWorkspaceId)
      .sort((a, b) => b.updatedAt - a.updatedAt),
    [agentSessions, currentWorkspaceId]
  );
  const agentGroups = useMemo(() => groupByDate(filteredAgentSessions), [filteredAgentSessions]);

  const beginEditConversation = (item: ConversationMeta): void => {
    setEditing({ id: item.id, type: "conversation", draft: item.title });
  };
  const beginEditAgent = (item: AgentSessionMeta): void => {
    setEditing({ id: item.id, type: "agent", draft: item.title });
  };

  const saveEdit = async (): Promise<void> => {
    if (!editing) return;
    const next = editing.draft.trim();
    if (!next) {
      setEditing(null);
      return;
    }
    if (editing.type === "conversation") {
      const current = conversations.find((item) => item.id === editing.id);
      if (!current || next === current.title) {
        setEditing(null);
        return;
      }
      const updated = await updateConversationTitle(editing.id, next);
      setConversations((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
    } else {
      const current = agentSessions.find((item) => item.id === editing.id);
      if (!current || next === current.title) {
        setEditing(null);
        return;
      }
      const updated = await updateAgentSessionTitle(editing.id, next);
      setAgentSessions((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
    }
    setEditing(null);
  };

  const createNew = async (): Promise<void> => {
    if (mode === "chat") {
      const created = await createConversation({
        modelId: selectedModel?.modelId,
        channelId: selectedModel?.channelId
      });
      setConversations((prev) => [created, ...prev]);
      setCurrentConversationId(created.id);
      setActiveView("conversations");
      return;
    }
    const created = await createAgentSession({
      title: "新 Agent 会话",
      workspaceId: currentWorkspaceId ?? undefined
    });
    setAgentSessions((prev) => [created, ...prev]);
    setCurrentAgentSessionId(created.id);
    setActiveView("conversations");
  };

  const confirmDelete = async (): Promise<void> => {
    if (!pendingDelete) return;
    if (pendingDelete.type === "conversation") {
      await deleteConversationById(pendingDelete.id);
      const next = await listConversations();
      setConversations(next);
      if (currentConversationId === pendingDelete.id) {
        setCurrentConversationId(next[0]?.id ?? null);
      }
    } else {
      await deleteAgentSessionById(pendingDelete.id);
      const next = await listAgentSessions();
      setAgentSessions(next);
      if (currentAgentSessionId === pendingDelete.id) {
        setCurrentAgentSessionId(next[0]?.id ?? null);
      }
    }
    setPendingDelete(null);
  };

  const rowClass = (active: boolean): string =>
    cn(
      "group flex w-full items-center gap-2 rounded-[10px] px-3 py-[7px] text-left text-[13px] transition-colors duration-100",
      active
        ? "bg-foreground/[0.08] text-foreground shadow-[0_1px_2px_0_rgba(0,0,0,0.05)]"
        : "text-foreground/80 hover:bg-foreground/[0.04]"
    );

  return (
    <div
      className="h-full flex flex-col bg-background"
      style={{ width: width ?? 280, minWidth: 180, flexShrink: 1 }}
    >
      <div className="pt-[50px]">
        <ModeSwitcher />
      </div>

      {mode === "agent" ? (
        <div className="px-3 pt-3">
          <WorkspaceSelector
            workspaces={agentWorkspaces}
            value={currentWorkspaceId}
            onChange={setCurrentWorkspaceId}
            onWorkspaceChange={setAgentWorkspaces}
          />
        </div>
      ) : null}

      <div className="px-3 pt-2">
        <button
          type="button"
          onClick={() => { void createNew(); }}
          className="titlebar-no-drag flex w-full items-center gap-2 rounded-[10px] border border-dashed border-foreground/10 bg-foreground/[0.04] px-3 py-2 text-[13px] font-medium text-foreground/70 transition-colors hover:border-foreground/20 hover:bg-foreground/[0.08]"
        >
          <Plus size={14} />
          <span>{mode === "chat" ? "新对话" : "新会话"}</span>
        </button>
      </div>

      {mode === "chat" ? (
        <div className="px-3 pt-3">
          <button
            type="button"
            className="titlebar-no-drag flex w-full items-center justify-between rounded-[10px] px-3 py-2 text-[13px] text-foreground/70 transition-colors hover:bg-foreground/[0.04]"
            onClick={() => setPinnedExpanded((prev) => !prev)}
          >
            <span className="inline-flex items-center gap-2"><Pin size={14} />置顶对话</span>
            {pinnedConversations.length > 0 ? (pinnedExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />) : null}
          </button>
        </div>
      ) : null}

      {mode === "chat" && pinnedExpanded && pinnedConversations.length > 0 ? (
        <div className="px-3 pb-1">
          <div className="ml-2 flex flex-col gap-0.5 border-l-2 border-primary/20 pl-1">
            {pinnedConversations.map((item) => (
              <ContextMenu key={`pin-${item.id}`}>
                <ContextMenuTrigger asChild>
                  <div
                    role="button"
                    tabIndex={0}
                  className={rowClass(currentConversationId === item.id)}
                  onClick={() => {
                    setCurrentConversationId(item.id);
                    setActiveView("conversations");
                  }}
                  onDoubleClick={() => beginEditConversation(item)}
                  onMouseEnter={() => setHoveredId(`pin-${item.id}`)}
                  onMouseLeave={() => setHoveredId((prev) => (prev === `pin-${item.id}` ? null : prev))}
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
                          ref={inputRef}
                          value={editing.draft}
                          onChange={(event) => setEditing((prev) => (prev ? { ...prev, draft: event.target.value } : prev))}
                          onBlur={() => { void saveEdit(); }}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") { event.preventDefault(); void saveEdit(); }
                            if (event.key === "Escape") setEditing(null);
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
                        hoveredId === `pin-${item.id}` && !(editing?.type === "conversation" && editing.id === item.id)
                          ? "opacity-100"
                          : "pointer-events-none opacity-0"
                      )}
                      onClick={(event) => {
                        event.stopPropagation();
                        setPendingDelete({ id: item.id, type: "conversation" });
                      }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent className="w-40">
                  <ContextMenuItem className="gap-2 text-[13px]" onSelect={() => { void togglePinConversation(item.id).then((updated) => setConversations((prev) => prev.map((c) => (c.id === updated.id ? updated : c)))); }}>
                    <PinOff size={14} />取消置顶
                  </ContextMenuItem>
                  <ContextMenuItem className="gap-2 text-[13px]" onSelect={() => beginEditConversation(item)}>
                    <Pencil size={14} />重命名
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem className="gap-2 text-[13px] text-destructive focus:text-destructive" onSelect={() => setPendingDelete({ id: item.id, type: "conversation" })}>
                    <Trash2 size={14} />删除
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            ))}
          </div>
        </div>
      ) : null}

      <div className="scrollbar-none flex-1 overflow-y-auto px-3 pt-2 pb-3">
        {mode === "chat"
          ? conversationGroups.map((group) => (
              <div key={group.label} className="mb-1">
                <div className="select-none px-3 pt-2 pb-1 text-[11px] font-medium text-foreground/40">{group.label}</div>
                <div className="flex flex-col gap-0.5">
                  {group.items.map((item) => (
                    <ContextMenu key={item.id}>
                      <ContextMenuTrigger asChild>
                        <div
                          role="button"
                          tabIndex={0}
                          className={rowClass(currentConversationId === item.id)}
                          onClick={() => {
                            setCurrentConversationId(item.id);
                            setActiveView("conversations");
                          }}
                          onDoubleClick={() => beginEditConversation(item)}
                          onMouseEnter={() => setHoveredId(item.id)}
                          onMouseLeave={() => setHoveredId((prev) => (prev === item.id ? null : prev))}
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
                                ref={inputRef}
                                value={editing.draft}
                                onChange={(event) => setEditing((prev) => (prev ? { ...prev, draft: event.target.value } : prev))}
                                onBlur={() => { void saveEdit(); }}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter") { event.preventDefault(); void saveEdit(); }
                                  if (event.key === "Escape") setEditing(null);
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
                              hoveredId === item.id && !(editing?.type === "conversation" && editing.id === item.id)
                                ? "opacity-100"
                                : "pointer-events-none opacity-0"
                            )}
                            onClick={(event) => {
                              event.stopPropagation();
                              setPendingDelete({ id: item.id, type: "conversation" });
                            }}
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </ContextMenuTrigger>
                      <ContextMenuContent className="w-40">
                        <ContextMenuItem className="gap-2 text-[13px]" onSelect={() => { void togglePinConversation(item.id).then((updated) => setConversations((prev) => prev.map((c) => (c.id === updated.id ? updated : c)))); }}>
                          {item.pinned ? <PinOff size={14} /> : <Pin size={14} />}
                          {item.pinned ? "取消置顶" : "置顶对话"}
                        </ContextMenuItem>
                        <ContextMenuItem className="gap-2 text-[13px]" onSelect={() => beginEditConversation(item)}>
                          <Pencil size={14} />重命名
                        </ContextMenuItem>
                        <ContextMenuSeparator />
                        <ContextMenuItem className="gap-2 text-[13px] text-destructive focus:text-destructive" onSelect={() => setPendingDelete({ id: item.id, type: "conversation" })}>
                          <Trash2 size={14} />删除
                        </ContextMenuItem>
                      </ContextMenuContent>
                    </ContextMenu>
                  ))}
                </div>
              </div>
            ))
          : agentGroups.map((group) => (
              <div key={group.label} className="mb-1">
                <div className="select-none px-3 pt-2 pb-1 text-[11px] font-medium text-foreground/40">{group.label}</div>
                <div className="flex flex-col gap-0.5">
                  {group.items.map((item) => (
                    <ContextMenu key={item.id}>
                      <ContextMenuTrigger asChild>
                        <div
                          role="button"
                          tabIndex={0}
                          className={rowClass(currentAgentSessionId === item.id)}
                          onClick={() => {
                            setCurrentAgentSessionId(item.id);
                            setActiveView("conversations");
                          }}
                          onDoubleClick={() => beginEditAgent(item)}
                          onMouseEnter={() => setHoveredId(item.id)}
                          onMouseLeave={() => setHoveredId((prev) => (prev === item.id ? null : prev))}
                        >
                          {runningIds.has(item.id) ? (
                            <span className="relative flex size-4 shrink-0 items-center justify-center">
                              <span className="absolute size-2 rounded-full bg-blue-500/60 animate-ping" />
                              <span className="relative block size-2 rounded-full bg-blue-500" />
                            </span>
                          ) : null}
                          <div className="min-w-0 flex-1">
                            {editing?.type === "agent" && editing.id === item.id ? (
                              <input
                                ref={inputRef}
                                value={editing.draft}
                                onChange={(event) => setEditing((prev) => (prev ? { ...prev, draft: event.target.value } : prev))}
                                onBlur={() => { void saveEdit(); }}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter") { event.preventDefault(); void saveEdit(); }
                                  if (event.key === "Escape") setEditing(null);
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
                              hoveredId === item.id && !(editing?.type === "agent" && editing.id === item.id)
                                ? "opacity-100"
                                : "pointer-events-none opacity-0"
                            )}
                            onClick={(event) => {
                              event.stopPropagation();
                              setPendingDelete({ id: item.id, type: "agent" });
                            }}
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </ContextMenuTrigger>
                      <ContextMenuContent className="w-40">
                        <ContextMenuItem className="gap-2 text-[13px]" onSelect={() => beginEditAgent(item)}>
                          <Pencil size={14} />重命名
                        </ContextMenuItem>
                        <ContextMenuSeparator />
                        <ContextMenuItem className="gap-2 text-[13px] text-destructive focus:text-destructive" onSelect={() => setPendingDelete({ id: item.id, type: "agent" })}>
                          <Trash2 size={14} />删除
                        </ContextMenuItem>
                      </ContextMenuContent>
                    </ContextMenu>
                  ))}
                </div>
              </div>
            ))}
      </div>

      {mode === "agent" && capabilities ? (
        <div className="px-3 pb-1">
          <button
            type="button"
            className="titlebar-no-drag flex w-full items-center gap-3 rounded-[10px] px-3 py-2 text-[12px] text-foreground/50 transition-colors hover:bg-foreground/[0.04] hover:text-foreground/70"
            onClick={() => setActiveView("settings")}
          >
            <div className="flex min-w-0 flex-1 items-center gap-2.5">
              <span className="inline-flex items-center gap-1">
                <Plug size={13} className="text-foreground/40" />
                <span className="tabular-nums">{capabilities.mcp}</span>
                <span className="text-foreground/30">MCP</span>
              </span>
              <span className="text-foreground/20">·</span>
              <span className="inline-flex items-center gap-1">
                <Zap size={13} className="text-foreground/40" />
                <span className="tabular-nums">{capabilities.skills}</span>
                <span className="text-foreground/30">Skills</span>
              </span>
            </div>
          </button>
        </div>
      ) : null}

      <div className="px-3 pb-3">
        <button
          type="button"
          className={cn(
            "titlebar-no-drag flex w-full items-center justify-between rounded-[10px] px-3 py-2 text-left text-[13px] transition-colors",
            activeView === "settings"
              ? "bg-foreground/[0.08] text-foreground shadow-[0_1px_2px_0_rgba(0,0,0,0.05)]"
              : "text-foreground/60 hover:bg-foreground/[0.04] hover:text-foreground"
          )}
          onClick={() => setActiveView("settings")}
        >
          <span className="inline-flex items-center gap-3">
            <span className="inline-flex h-[18px] w-[18px] items-center justify-center">
              <Settings size={18} />
            </span>
            <span>设置</span>
          </span>
          {hasUpdate ? <span className="h-2 w-2 rounded-full bg-red-500" /> : null}
        </button>
      </div>

      <AlertDialog open={pendingDelete !== null} onOpenChange={(open) => { if (!open) setPendingDelete(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{pendingDelete?.type === "agent" ? "确认删除会话" : "确认删除对话"}</AlertDialogTitle>
            <AlertDialogDescription>
              删除后将无法恢复，确定要删除这个对话吗？
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { void confirmDelete(); }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
