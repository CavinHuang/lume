import { AGENT_IPC_CHANNELS } from "@lume/shared";
import { getRecentAgentThreadMessages } from "../services/agent/agent-thread-manager";
import {
  getWorkspaceSkills,
  deleteWorkspaceSkill,
} from "../services/agent/agent-workspace-manager";
import { listInvocableCapabilities } from "../services/agent/invocable-capability-catalog";
import {
  analyzeWorkspaceSkillImprovement,
  applyWorkspaceSkillImprovement,
  listWorkspaceSkillVersions,
  restoreWorkspaceSkillVersion,
} from "../services/skills/skill-evolution-service";
import {
  deleteEditableSkill,
  getEditableSkill,
  listEditableSkills,
  saveWorkspaceSkill,
} from "../services/skills/workspace-skill-editor-service";
import {
  getSkillMarketDetail,
  getSkillMarketCatalog,
} from "../services/skills/skills-market-service";
import {
  applySkillImprovementInputSchema,
  deleteSkillInputSchema,
  editableSkillInputSchema,
  listEditableSkillsInputSchema,
  listInvocableCapabilitiesInputSchema,
  saveSkillInputSchema,
  skillImprovementAnalysisInputSchema,
  skillMarketCatalogInputSchema,
  skillMarketDetailInputSchema,
  skillVersionInputSchema,
  workspaceSlugInputSchema,
} from "./schemas";
import type { RpcHandler } from "./types";
import { validateInput } from "./validation";

export function createSkillHandlers(): Record<string, RpcHandler> {
  return {
    [AGENT_IPC_CHANNELS.GET_SKILLS]: async (params) => {
      const input = validateInput(
        workspaceSlugInputSchema,
        params,
        AGENT_IPC_CHANNELS.GET_SKILLS,
      );
      return getWorkspaceSkills(input.workspaceSlug);
    },
    [AGENT_IPC_CHANNELS.LIST_EDITABLE_SKILLS]: async (params) => {
      const input = validateInput(
        listEditableSkillsInputSchema,
        params,
        AGENT_IPC_CHANNELS.LIST_EDITABLE_SKILLS,
      );
      return listEditableSkills(input);
    },
    [AGENT_IPC_CHANNELS.LIST_INVOCABLE_CAPABILITIES]: async (params) => {
      const input = validateInput(
        listInvocableCapabilitiesInputSchema,
        params,
        AGENT_IPC_CHANNELS.LIST_INVOCABLE_CAPABILITIES,
      );
      return listInvocableCapabilities(input);
    },
    [AGENT_IPC_CHANNELS.GET_EDITABLE_SKILL]: async (params) => {
      const input = validateInput(
        editableSkillInputSchema,
        params,
        AGENT_IPC_CHANNELS.GET_EDITABLE_SKILL,
      );
      return getEditableSkill(input);
    },
    [AGENT_IPC_CHANNELS.SAVE_SKILL]: async (params) => {
      const input = validateInput(
        saveSkillInputSchema,
        params,
        AGENT_IPC_CHANNELS.SAVE_SKILL,
      );
      return saveWorkspaceSkill(input);
    },
    [AGENT_IPC_CHANNELS.DELETE_SKILL]: async (params) => {
      const input = validateInput(
        deleteSkillInputSchema,
        params,
        AGENT_IPC_CHANNELS.DELETE_SKILL,
      );
      if (input.storageScope) {
        deleteEditableSkill({
          storageScope: input.storageScope,
          workspaceSlug: input.workspaceSlug,
          skillSlug: input.skillSlug,
          cwd: input.cwd,
        });
        return { ok: true };
      }
      deleteWorkspaceSkill(input.workspaceSlug, input.skillSlug);
      return { ok: true };
    },
    [AGENT_IPC_CHANNELS.GET_SKILL_MARKET_CATALOG]: async (params) => {
      const input = validateInput(
        skillMarketCatalogInputSchema,
        params,
        AGENT_IPC_CHANNELS.GET_SKILL_MARKET_CATALOG,
      );
      return getSkillMarketCatalog(input);
    },
    [AGENT_IPC_CHANNELS.GET_SKILL_MARKET_DETAIL]: async (params) => {
      const input = validateInput(
        skillMarketDetailInputSchema,
        params,
        AGENT_IPC_CHANNELS.GET_SKILL_MARKET_DETAIL,
      );
      return getSkillMarketDetail(input);
    },
    [AGENT_IPC_CHANNELS.LIST_SKILL_VERSIONS]: async (params) => {
      const input = validateInput(
        skillVersionInputSchema,
        params,
        AGENT_IPC_CHANNELS.LIST_SKILL_VERSIONS,
      );
      return listWorkspaceSkillVersions(input);
    },
    [AGENT_IPC_CHANNELS.RESTORE_SKILL_VERSION]: async (params) => {
      const input = validateInput(
        skillVersionInputSchema.required({ filename: true }),
        params,
        AGENT_IPC_CHANNELS.RESTORE_SKILL_VERSION,
      );
      return restoreWorkspaceSkillVersion(input);
    },
    [AGENT_IPC_CHANNELS.ANALYZE_SKILL_IMPROVEMENT]: async (params) => {
      const input = validateInput(
        skillImprovementAnalysisInputSchema,
        params,
        AGENT_IPC_CHANNELS.ANALYZE_SKILL_IMPROVEMENT,
      );
      return analyzeWorkspaceSkillImprovement({
        ...input,
        getRecentMessages: (threadId, limit) =>
          getRecentAgentThreadMessages(threadId, limit).messages,
      });
    },
    [AGENT_IPC_CHANNELS.APPLY_SKILL_IMPROVEMENT]: async (params) => {
      const input = validateInput(
        applySkillImprovementInputSchema,
        params,
        AGENT_IPC_CHANNELS.APPLY_SKILL_IMPROVEMENT,
      );
      return applyWorkspaceSkillImprovement(input);
    },
  };
}
