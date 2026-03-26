"use client";

import { useEffect, useMemo, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { FolderOpen, MessageSquare, Sparkles, Trash2 } from "lucide-react";
import type { SkillMeta } from "@lume/shared";
import {
  activeViewAtom,
  agentChannelIdAtom,
  agentPendingPromptAtom,
  agentSessionsAtom,
  agentWorkspacesAtom,
  appModeAtom,
  currentAgentSessionIdAtom,
  currentAgentWorkspaceIdAtom,
  workspaceCapabilitiesVersionAtom
} from "@/atoms";
import { Button } from "@/components/ui/button";
import {
  createAgentSession,
  deleteAgentWorkspaceSkill,
  listAgentSessions,
  listAgentWorkspaceSkills
} from "@/lib/desktop-api/agent";
import { SettingsCard, SettingsRow, SettingsSection } from "./primitives";

export function SkillsSettings(): React.ReactElement {
  const workspaces = useAtomValue(agentWorkspacesAtom);
  const currentWorkspaceId = useAtomValue(currentAgentWorkspaceIdAtom);
  const agentChannelId = useAtomValue(agentChannelIdAtom);
  const workspace = useMemo(
    () => workspaces.find((item) => item.id === currentWorkspaceId) ?? null,
    [workspaces, currentWorkspaceId]
  );

  const setAgentSessions = useSetAtom(agentSessionsAtom);
  const setCurrentSessionId = useSetAtom(currentAgentSessionIdAtom);
  const setPendingPrompt = useSetAtom(agentPendingPromptAtom);
  const setActiveView = useSetAtom(activeViewAtom);
  const setAppMode = useSetAtom(appModeAtom);
  const bumpCapabilitiesVersion = useSetAtom(workspaceCapabilitiesVersionAtom);
  const capabilitiesVersion = useAtomValue(workspaceCapabilitiesVersionAtom);

  const workspaceSlug = workspace?.slug ?? "";
  const [skills, setSkills] = useState<SkillMeta[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!workspaceSlug) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const list = await listAgentWorkspaceSkills(workspaceSlug);
        if (!cancelled) setSkills(list);
      } catch (error) {
        console.error("[SkillsSettings] load skills failed", error);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [workspaceSlug, capabilitiesVersion]);

  const handleDeleteSkill = async (skillSlug: string, skillName: string): Promise<void> => {
    if (!window.confirm(`确定删除 Skill「${skillName}」？此操作不可恢复。`)) return;
    await deleteAgentWorkspaceSkill(workspaceSlug, skillSlug);
    setSkills((prev) => prev.filter((item) => item.slug !== skillSlug));
    bumpCapabilitiesVersion((v) => v + 1);
  };

  const handleConfigViaChat = async (): Promise<void> => {
    if (!agentChannelId) {
      window.alert("请先在渠道设置中选择 Agent 供应商");
      return;
    }

    const skillsDir = `~/.lume/agent-workspaces/${workspaceSlug}/skills/`;
    const skillList = skills.length > 0
      ? skills.map((item) => `- ${item.name}: ${item.description ?? "无描述"}`).join("\n")
      : "暂无 Skill";

    const promptMessage = `请帮我配置当前工作区的 Skills，你要主动来帮我实现，你可以采用联网搜索深度研究来尝试，当前环境已经有 Claude Agent SDK 了，除非不确定的时候才来问我，否则默认将帮我完成安装，而不是指导我。

## 工作区信息
- 工作区: ${workspace?.name}
- Skills 目录: ${skillsDir}

## Skill 格式
每个 Skill 是 skills/ 目录下的一个子目录，目录名即 slug。
目录内包含 SKILL.md 文件，格式：

\`\`\`markdown
---
name: Skill 显示名称
description: 简要描述
---

Skill 的详细指令内容...
\`\`\`

## 当前 Skills
${skillList}

请查看 skills/ 目录了解现有配置，根据我的需求创建或编辑 Skill。`;

    try {
      const session = await createAgentSession({
        channelId: agentChannelId ?? undefined,
        workspaceId: currentWorkspaceId ?? undefined
      });
      const sessions = await listAgentSessions();
      setAgentSessions(sessions);
      setCurrentSessionId(session.id);
      setPendingPrompt({ sessionId: session.id, message: promptMessage });
      setAppMode("agent");
      setActiveView("conversations");
    } catch (error) {
      console.error("[SkillsSettings] create config session failed", error);
    }
  };

  if (!workspace) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <FolderOpen size={48} className="mb-4 text-muted-foreground/50" />
        <p className="text-sm text-muted-foreground">请先在 Agent 模式下选择或创建一个工作区</p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <SettingsSection title="Skills" description={`工作区: ${workspace.name} · 将 SKILL.md 放入 skills/ 目录即可被 Agent 自动发现`}>
        {loading ? (
          <div className="py-8 text-center text-sm text-muted-foreground">加载中...</div>
        ) : skills.length === 0 ? (
          <SettingsCard divided={false}>
            <div className="py-8 text-center text-sm text-muted-foreground">暂无 Skill</div>
          </SettingsCard>
        ) : (
          <SettingsCard>
            {skills.map((skill) => (
              <SettingsRow
                key={skill.slug}
                label={skill.name}
                icon={<Sparkles size={18} className="text-amber-500" />}
                description={skill.description ?? skill.slug}
                className="group"
              >
                <button
                  type="button"
                  onClick={() => { void handleDeleteSkill(skill.slug, skill.name); }}
                  className="rounded-md p-1.5 text-muted-foreground opacity-0 transition-colors group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive"
                  title="删除"
                >
                  <Trash2 size={14} />
                </button>
              </SettingsRow>
            ))}
          </SettingsCard>
        )}
        <Button size="sm" className="w-full" type="button" onClick={() => { void handleConfigViaChat(); }}>
          <MessageSquare size={14} />
          <span>跟 Lume Agent 对话完成配置</span>
        </Button>
      </SettingsSection>
    </div>
  );
}
