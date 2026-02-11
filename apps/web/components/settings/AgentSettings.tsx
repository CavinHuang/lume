"use client";

import { useEffect, useMemo, useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import type { McpServerEntry, SkillMeta, WorkspaceMcpConfig } from "@lume/shared";
import { useAtomValue } from "jotai";
import { agentWorkspacesAtom, currentAgentWorkspaceIdAtom } from "@/atoms";
import { Button } from "@/components/ui/button";
import {
  deleteAgentWorkspaceSkill,
  getAgentWorkspaceMcpConfig,
  listAgentWorkspaceSkills,
  saveAgentWorkspaceMcpConfig
} from "@/lib/desktop-api";
import { McpServerForm } from "./McpServerForm";
import { SettingsCard, SettingsRow, SettingsSection } from "./primitives";

type ViewMode = "list" | "create" | "edit";

type EditingServer = {
  name: string;
  entry: McpServerEntry;
};

export function AgentSettings(): React.ReactElement {
  const workspaces = useAtomValue(agentWorkspacesAtom);
  const currentWorkspaceId = useAtomValue(currentAgentWorkspaceIdAtom);
  const workspace = useMemo(
    () => workspaces.find((item) => item.id === currentWorkspaceId) ?? null,
    [workspaces, currentWorkspaceId]
  );

  const workspaceSlug = workspace?.slug ?? "";
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [editingServer, setEditingServer] = useState<EditingServer | null>(null);
  const [mcpConfig, setMcpConfig] = useState<WorkspaceMcpConfig>({ servers: {} });
  const [skills, setSkills] = useState<SkillMeta[]>([]);
  const [loading, setLoading] = useState(true);

  const loadData = async (): Promise<void> => {
    if (!workspaceSlug) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [config, skillList] = await Promise.all([
        getAgentWorkspaceMcpConfig(workspaceSlug),
        listAgentWorkspaceSkills(workspaceSlug)
      ]);
      setMcpConfig(config);
      setSkills(skillList);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, [workspaceSlug]);

  if (!workspace) {
    return (
      <div className="rounded-xl border border-slate-700 bg-slate-950/50 p-3">
        <h3 className="text-base font-semibold">Agent</h3>
        <p className="text-sm text-muted-foreground">请先在左侧选择一个工作区。</p>
      </div>
    );
  }

  if (viewMode !== "list") {
    return (
      <McpServerForm
        server={viewMode === "edit" ? editingServer : null}
        workspaceSlug={workspaceSlug}
        onSaved={() => {
          setViewMode("list");
          setEditingServer(null);
          void loadData();
        }}
        onCancel={() => {
          setViewMode("list");
          setEditingServer(null);
        }}
      />
    );
  }

  const serverEntries = Object.entries(mcpConfig.servers ?? {});

  return (
    <div className="flex flex-col gap-4">
      <SettingsSection
        title="MCP 服务器"
        description={`当前工作区：${workspace.name}`}
        action={
          <Button type="button" onClick={() => setViewMode("create")}>
            <Plus size={14} />
            添加服务器
          </Button>
        }
      >
        {loading ? (
          <div className="text-sm text-muted-foreground">加载中...</div>
        ) : serverEntries.length === 0 ? (
          <SettingsCard divided={false}>
            <div className="text-sm text-muted-foreground">当前还没有 MCP 服务器。</div>
          </SettingsCard>
        ) : (
          <SettingsCard>
            {serverEntries.map(([name, entry]) => (
              <SettingsRow key={name} label={name} description={`${entry.type} · ${entry.enabled ? "已启用" : "已禁用"}`}>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-slate-300 hover:bg-slate-800"
                    onClick={() => {
                      setEditingServer({ name, entry });
                      setViewMode("edit");
                    }}
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    type="button"
                    className="rounded border border-red-900 bg-red-950/30 px-2 py-1 text-red-300 hover:bg-red-900/40"
                    onClick={async () => {
                      if (!window.confirm(`确定删除 MCP 服务器「${name}」？`)) return;
                      const next = { ...mcpConfig.servers };
                      delete next[name];
                      await saveAgentWorkspaceMcpConfig(workspaceSlug, { servers: next });
                      await loadData();
                    }}
                  >
                    <Trash2 size={13} />
                  </button>
                  <input
                    type="checkbox"
                    checked={entry.enabled}
                    onChange={async () => {
                      const next = {
                        ...mcpConfig.servers,
                        [name]: {
                          ...entry,
                          enabled: !entry.enabled
                        }
                      };
                      await saveAgentWorkspaceMcpConfig(workspaceSlug, { servers: next });
                      await loadData();
                    }}
                  />
                </div>
              </SettingsRow>
            ))}
          </SettingsCard>
        )}
      </SettingsSection>

      <SettingsSection title="Skills" description={`当前工作区：${workspace.name}`}>
        {loading ? (
          <div className="text-sm text-muted-foreground">加载中...</div>
        ) : skills.length === 0 ? (
          <SettingsCard divided={false}>
            <div className="text-sm text-muted-foreground">当前还没有 Skills。</div>
          </SettingsCard>
        ) : (
          <SettingsCard>
            {skills.map((skill) => (
              <SettingsRow key={skill.slug} label={skill.name} description={skill.description ?? skill.slug}>
                <button
                  type="button"
                  className="rounded border border-red-900 bg-red-950/30 px-2 py-1 text-red-300 hover:bg-red-900/40"
                  onClick={async () => {
                    if (!window.confirm(`确定删除 Skill「${skill.name}」？`)) return;
                    await deleteAgentWorkspaceSkill(workspaceSlug, skill.slug);
                    await loadData();
                  }}
                >
                  <Trash2 size={13} />
                </button>
              </SettingsRow>
            ))}
          </SettingsCard>
        )}
      </SettingsSection>
    </div>
  );
}
