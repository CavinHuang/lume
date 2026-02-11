"use client";

import { useEffect, useState } from "react";
import { useAtom, useAtomValue } from "jotai";
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
  type ActiveView
} from "@/atoms";
import {
  createAgentSession,
  createAgentWorkspace,
  createConversation,
  deleteAgentSessionById,
  deleteConversationById,
  ensureDefaultAgentWorkspace,
  getAgentWorkspaceCapabilities,
  listAgentSessions,
  listAgentWorkspaces,
  listConversations,
  updateAgentSessionTitle,
  updateConversationTitle
} from "@/lib/desktop-api";
import { cn } from "@/lib/utils";
import { ModeSwitcher } from "./ModeSwitcher";

const NAV_ITEMS: Array<{ id: ActiveView; label: string }> = [
  { id: "conversations", label: "Conversations" },
  { id: "settings", label: "Settings" }
];

export function LeftSidebar(): React.ReactElement {
  const mode = useAtomValue(appModeAtom);
  const [activeView, setActiveView] = useAtom(activeViewAtom);

  const [conversations, setConversations] = useAtom(conversationsAtom);
  const [currentConversationId, setCurrentConversationId] = useAtom(currentConversationIdAtom);

  const [agentSessions, setAgentSessions] = useAtom(agentSessionsAtom);
  const [agentWorkspaces, setAgentWorkspaces] = useAtom(agentWorkspacesAtom);
  const [currentWorkspaceId, setCurrentWorkspaceId] = useAtom(currentAgentWorkspaceIdAtom);
  const [currentAgentSessionId, setCurrentAgentSessionId] = useAtom(currentAgentSessionIdAtom);
  const runningIds = useAtomValue(agentRunningSessionIdsAtom);
  const [capabilityText, setCapabilityText] = useState<string>("");

  useEffect(() => {
    void listConversations().then((items) => {
      setConversations(items);
      const first = items[0];
      if (!currentConversationId && first) {
        setCurrentConversationId(first.id);
      }
    });

    void listAgentSessions().then((items) => {
      setAgentSessions(items);
      const first = items[0];
      if (!currentAgentSessionId && first) {
        setCurrentAgentSessionId(first.id);
      }
    });

    void (async () => {
      await ensureDefaultAgentWorkspace();
      const workspaces = await listAgentWorkspaces();
      setAgentWorkspaces(workspaces);
      const firstWorkspace = workspaces[0];
      if (!currentWorkspaceId && firstWorkspace) {
        setCurrentWorkspaceId(firstWorkspace.id);
      }
    })();
  }, [
    currentWorkspaceId,
    currentAgentSessionId,
    currentConversationId,
    setAgentSessions,
    setAgentWorkspaces,
    setCurrentWorkspaceId,
    setConversations,
    setCurrentAgentSessionId,
    setCurrentConversationId
  ]);

  useEffect(() => {
    if (mode !== "agent" || !currentWorkspaceId) {
      setCapabilityText("");
      return;
    }
    const workspace = agentWorkspaces.find((item) => item.id === currentWorkspaceId);
    if (!workspace) return;
    void getAgentWorkspaceCapabilities(workspace.slug).then((capability) => {
      const enabledMcp = capability.mcpServers.filter((item) => item.enabled).length;
      setCapabilityText(`MCP ${enabledMcp} · Skills ${capability.skills.length}`);
    });
  }, [agentWorkspaces, currentWorkspaceId, mode]);

  const renameConversation = async (id: string, current: string): Promise<void> => {
    const next = window.prompt("重命名对话", current)?.trim();
    if (!next || next === current) return;
    const updated = await updateConversationTitle(id, next);
    setConversations((prev) => prev.map((item) => (item.id === id ? updated : item)));
  };

  const removeConversation = async (id: string): Promise<void> => {
    if (!window.confirm("确认删除这个对话？")) return;
    await deleteConversationById(id);
    const next = await listConversations();
    setConversations(next);
    if (currentConversationId === id) {
      setCurrentConversationId(next[0]?.id ?? null);
    }
  };

  const renameAgentSession = async (id: string, current: string): Promise<void> => {
    const next = window.prompt("重命名会话", current)?.trim();
    if (!next || next === current) return;
    const updated = await updateAgentSessionTitle(id, next);
    setAgentSessions((prev) => prev.map((item) => (item.id === id ? updated : item)));
  };

  const removeAgentSession = async (id: string): Promise<void> => {
    if (!window.confirm("确认删除这个会话？")) return;
    await deleteAgentSessionById(id);
    const next = await listAgentSessions();
    setAgentSessions(next);
    if (currentAgentSessionId === id) {
      setCurrentAgentSessionId(next[0]?.id ?? null);
    }
  };

  const navItemClass = (active: boolean): string =>
    cn(
      "w-full rounded-lg border border-transparent px-3 py-2 text-left text-sm transition-colors",
      active
        ? "border-slate-500/60 bg-slate-700/70 text-cyan-50"
        : "text-muted-foreground hover:bg-slate-800/80 hover:text-foreground"
    );

  const listItemClass = (active: boolean): string =>
    cn(
      "flex w-full items-center justify-between rounded-lg border px-2.5 py-2 text-left transition-colors",
      active
        ? "border-slate-500/70 bg-slate-800/80 text-cyan-50"
        : "border-transparent text-muted-foreground hover:bg-slate-800/70 hover:text-foreground"
    );

  const actionBtnClass =
    "rounded-md border border-slate-700 bg-slate-900 px-2 py-0.5 text-[11px] text-slate-300 transition-colors hover:bg-slate-800";
  const dangerBtnClass =
    "rounded-md border border-red-900 bg-red-950/30 px-2 py-0.5 text-[11px] text-red-300 transition-colors hover:bg-red-900/40";

  return (
    <aside className="flex min-w-0 flex-col gap-3 rounded-2xl border border-border/60 bg-gradient-to-b from-slate-900 to-slate-950 p-3 lg:p-3.5">
      <header className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-bold tracking-tight">Lume</h1>
        <span className="rounded-full bg-cyan-700 px-2 py-0.5 text-[11px] font-semibold text-cyan-100">
          {mode.toUpperCase()}
        </span>
      </header>

      <section className="flex flex-col gap-2">
        <p className="text-xs uppercase tracking-wider text-muted-foreground">Mode</p>
        <div className="rounded-xl border border-border/60 bg-slate-900/60 p-1.5">
          <ModeSwitcher />
        </div>
      </section>

      <nav className="flex flex-col gap-2">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={navItemClass(activeView === item.id)}
            onClick={() => setActiveView(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <section className="flex min-h-0 flex-1 flex-col gap-2.5 border-t border-border/60 pt-2.5">
        <button
          type="button"
          className="rounded-lg border border-dashed border-blue-500/70 bg-blue-900/20 px-3 py-2 text-left text-sm text-blue-200 transition-colors hover:bg-blue-900/30"
          onClick={async () => {
            if (mode === "chat") {
              const created = await createConversation();
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
          }}
        >
          {mode === "chat" ? "+ New Conversation" : "+ New Session"}
        </button>

        {mode === "agent" ? (
          <div className="grid grid-cols-[1fr_auto] items-center gap-1.5">
            <select
              className="h-9 rounded-md border border-slate-700 bg-slate-950 px-2.5 text-sm text-slate-200 outline-none focus:border-cyan-400"
              value={currentWorkspaceId ?? ""}
              onChange={(event) => setCurrentWorkspaceId(event.target.value || null)}
            >
              <option value="">选择工作区</option>
              {agentWorkspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className={actionBtnClass}
              onClick={async () => {
                const name = window.prompt("新工作区名称")?.trim();
                if (!name) return;
                const created = await createAgentWorkspace(name);
                setAgentWorkspaces((prev) => [created, ...prev]);
                setCurrentWorkspaceId(created.id);
              }}
            >
              New WS
            </button>
          </div>
        ) : null}

        {mode === "chat" ? (
          <ul className="flex min-h-0 list-none flex-col gap-1.5 overflow-auto p-0">
            {conversations.map((item) => (
              <li key={item.id}>
                <div
                  role="button"
                  tabIndex={0}
                  className={listItemClass(currentConversationId === item.id)}
                  onClick={() => {
                    setCurrentConversationId(item.id);
                    setActiveView("conversations");
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setCurrentConversationId(item.id);
                      setActiveView("conversations");
                    }
                  }}
                >
                  <span className="min-w-0 truncate">{item.title}</span>
                  <span className="ml-2 inline-flex items-center gap-1.5">
                    <button
                      type="button"
                      className={actionBtnClass}
                      onClick={(event) => {
                        event.stopPropagation();
                        void renameConversation(item.id, item.title);
                      }}
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      className={dangerBtnClass}
                      onClick={(event) => {
                        event.stopPropagation();
                        void removeConversation(item.id);
                      }}
                    >
                      Del
                    </button>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <ul className="flex min-h-0 list-none flex-col gap-1.5 overflow-auto p-0">
            {agentSessions.map((item) => (
              <li key={item.id}>
                <div
                  role="button"
                  tabIndex={0}
                  className={listItemClass(currentAgentSessionId === item.id)}
                  onClick={() => {
                    setCurrentAgentSessionId(item.id);
                    setActiveView("conversations");
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setCurrentAgentSessionId(item.id);
                      setActiveView("conversations");
                    }
                  }}
                >
                  <span className="min-w-0 truncate">{item.title}</span>
                  <span className="ml-2 inline-flex items-center gap-1.5">
                    {runningIds.has(item.id) ? <span className="h-2 w-2 rounded-full bg-green-500 shadow-[0_0_0_4px_rgba(34,197,94,0.2)]" /> : null}
                    <button
                      type="button"
                      className={actionBtnClass}
                      onClick={(event) => {
                        event.stopPropagation();
                        void renameAgentSession(item.id, item.title);
                      }}
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      className={dangerBtnClass}
                      onClick={(event) => {
                        event.stopPropagation();
                        void removeAgentSession(item.id);
                      }}
                    >
                      Del
                    </button>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}

        {mode === "agent" && capabilityText ? (
          <p className="text-xs text-muted-foreground">{capabilityText}</p>
        ) : null}
      </section>
    </aside>
  );
}
