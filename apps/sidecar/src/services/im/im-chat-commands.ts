import type { AgentThreadMeta, Channel } from "@lume/shared";
import { normalizeProviderId } from "../channel/model-selection";
import { getAgentWorkspace } from "../agent/agent-workspace-manager";

/**
 * IM 会话内斜杠命令层：/help /new /stop /now /model（含单字母别名）。
 *
 * 设计要点：
 * - 解析与呈现数据全部是纯函数（可测），路由器只做调度与发送；
 * - 命令只作用于当前绑定线程；模型切换写入线程级覆盖
 *   （channelId/modelRef），运行时解析本就「线程覆盖优先于全局默认」，
 *   因此桌面端改全局不影响已切换的会话；
 * - 未绑定线程的命令仅回复提示，不创建线程。
 */

export type ParsedImCommand =
  | { type: "none" }
  | { type: "invalid"; message: string }
  | { type: "help" }
  | { type: "new" }
  | { type: "stop" }
  | { type: "now" }
  | { type: "model"; args: string[] };

/** 命令名单一来源（含审批命令）：管线直通白名单据此动态构建，避免双处维护漂移 */
export const IM_CONTROL_COMMAND_NAMES = [
  "approve",
  "help", "h",
  "new",
  "stop", "s",
  "now", "n",
  "model", "m"
] as const;

const COMMAND_ALIASES: Record<string, ParsedImCommand["type"]> = {
  help: "help",
  h: "help",
  new: "new",
  stop: "stop",
  s: "stop",
  now: "now",
  n: "now",
  model: "model",
  m: "model"
};

/** 解析斜杠命令；非命令文本返回 none。支持 /command@botname 后缀。 */
export function parseImCommand(text: string): ParsedImCommand {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  const head = parts[0]?.toLowerCase();
  if (!head || !head.startsWith("/")) {
    return { type: "none" };
  }
  const name = head.slice(1).replace(/@\S+$/, "");
  const kind = COMMAND_ALIASES[name];
  if (!kind) {
    return { type: "none" };
  }
  const args = parts.slice(1);
  if (kind === "model") {
    return { type: "model", args };
  }
  if (args.length > 0 && (kind === "help" || kind === "new" || kind === "stop" || kind === "now")) {
    return {
      type: "invalid",
      message: `命令格式不正确：/${name} 不需要参数。发送 /help 查看用法。`
    };
  }
  return { type: kind } as ParsedImCommand;
}

export function formatImHelpText(): string {
  return [
    "可用命令：",
    "/new 开始新对话（重置当前会话上下文）",
    "/stop 停止正在进行的任务",
    "/now 查看当前会话信息",
    "/model 查看可用渠道",
    "/model <渠道序号> 查看该渠道的模型",
    "/model <渠道序号> <模型序号> 切换模型（仅当前会话生效）",
    "/help 显示本帮助"
  ].join("\n");
}

export function listEnabledChannels(channels: Channel[]): Channel[] {
  return channels.filter((channel) => channel.enabled !== false);
}

export function formatChannelListText(channels: Channel[]): string {
  const enabled = listEnabledChannels(channels);
  if (enabled.length === 0) {
    return "暂无启用的渠道。请先在 Lume 设置中添加并启用 AI 渠道。";
  }
  const lines = ["可用渠道："];
  enabled.forEach((channel, index) => {
    lines.push(`${index + 1}. ${channel.name}`);
  });
  lines.push("", "发送 /model <渠道序号> 查看模型列表。");
  return lines.join("\n");
}

export function formatModelListText(channel: Channel): string {
  const models = channel.models.filter((model) => model.enabled);
  if (models.length === 0) {
    return `渠道「${channel.name}」暂无启用模型。`;
  }
  const lines = [`「${channel.name}」的可用模型：`];
  models.forEach((model, index) => {
    const marker =
      model.id === channel.defaultModelId ? "（默认）" : "";
    lines.push(`${index + 1}. ${model.name}${marker}`);
  });
  lines.push("", "发送 /model <渠道序号> <模型序号> 切换。");
  return lines.join("\n");
}

export interface ImModelSwitchResult {
  ok: true;
  channelId: string;
  channelName: string;
  modelRef: string;
  modelId: string;
  modelName: string;
}

/** 解析 `/model <渠道序号> <模型序号>` 参数为线程级模型覆盖。 */
export function resolveImModelSwitch(
  channels: Channel[],
  args: string[]
): ImModelSwitchResult | { ok: false; message: string } {
  const [rawChannelIndex, rawModelIndex] = args;
  const enabled = listEnabledChannels(channels);
  const channelIndex = Number.parseInt(rawChannelIndex ?? "", 10);
  if (!rawChannelIndex || Number.isNaN(channelIndex) || channelIndex < 1 || channelIndex > enabled.length) {
    return {
      ok: false,
      message: enabled.length === 0
        ? "暂无启用的渠道。"
        : `渠道序号无效。发送 /model 查看 1-${enabled.length} 号渠道。`
    };
  }
  const channel = enabled[channelIndex - 1];
  if (!channel) {
    return { ok: false, message: "渠道序号无效。" };
  }
  const models = channel.models.filter((model) => model.enabled);
  if (!rawModelIndex) {
    return { ok: false, message: formatModelListText(channel) };
  }
  const modelIndex = Number.parseInt(rawModelIndex, 10);
  if (Number.isNaN(modelIndex) || modelIndex < 1 || modelIndex > models.length) {
    return {
      ok: false,
      message: models.length === 0
        ? `渠道「${channel.name}」暂无启用模型。`
        : `模型序号无效。发送 /model ${channelIndex} 查看 1-${models.length} 号模型。`
    };
  }
  const model = models[modelIndex - 1];
  if (!model) {
    return { ok: false, message: "模型序号无效。" };
  }
  return {
    ok: true,
    channelId: channel.id,
    channelName: channel.name,
    modelId: model.id,
    modelName: model.name,
    modelRef: `${normalizeProviderId(channel.provider)}/${model.id}`
  };
}

export interface ImNowInfoInput {
  peerKind: "dm" | "group";
  meta?: Pick<AgentThreadMeta, "title" | "channelId" | "modelRef"> | null;
  channels: Channel[];
  workspaceId?: string;
}

export function formatImNowText(input: ImNowInfoInput): string {
  const lines: string[] = [];
  if (input.meta?.title) {
    lines.push(`任务: ${input.meta.title}`);
  }
  lines.push(`会话类型: ${input.peerKind === "group" ? "群聊" : "单聊"}`);
  if (input.workspaceId) {
    const workspaceName = getAgentWorkspace(input.workspaceId)?.name;
    if (workspaceName) {
      lines.push(`工作区: ${workspaceName}`);
    }
  }
  const channelId = input.meta?.channelId;
  const modelRef = input.meta?.modelRef;
  if (channelId || modelRef) {
    const channel = channelId ? input.channels.find((item) => item.id === channelId) : undefined;
    const modelName = modelRef?.split("/").slice(1).join("/");
    let modelText = modelName ? `模型: ${modelName}` : "模型: 已配置";
    if (channel) {
      modelText += channel.enabled !== false
        ? `（渠道「${channel.name}」）`
        : `（渠道「${channel.name}」已停用）`;
    } else if (channelId) {
      modelText += "（原渠道已删除）";
    }
    lines.push(modelText);
  } else {
    lines.push("模型: 跟随全局默认");
  }
  lines.push("", "发送 /help 查看可用命令。");
  return lines.join("\n");
}
