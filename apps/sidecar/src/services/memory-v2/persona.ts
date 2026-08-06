import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname } from "node:path";
import type { LLMProvider } from "@lume/agent-sdk";
import type { PersonaProfile } from "@lume/shared";
import { resolveChannelModelBinding } from "../channel/channel-manager";
import { createLazyConnectionLlmProvider } from "../model-runtime/connection-provider";
import { getEffectiveLumeConfig } from "../system/lume-config-service";
import { MEMORY_CLAIM_PREFERRED_NAME, claimFromEntry } from "./claim";
import { resolveMemoryExtractionModelRefs } from "./extraction";
import { listEntries, readActivation } from "./markdown-store";
import { getPersonaPath } from "./paths";
import type { MemoryV2Entry, MemoryV2Scope } from "./types";

export { getPersonaPath };

export function readPersonaRaw(scope: MemoryV2Scope, workspaceSlug?: string): string | null {
  const path = getPersonaPath(scope, workspaceSlug);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf-8");
}

export function writePersona(
  scope: MemoryV2Scope,
  workspaceSlug: string | undefined,
  markdown: string
): void {
  const path = getPersonaPath(scope, workspaceSlug);
  writePersonaAtomic(path, markdown);
}

export function deletePersona(scope: MemoryV2Scope, workspaceSlug?: string): void {
  rmSync(getPersonaPath(scope, workspaceSlug), { force: true });
}

/**
 * persona 存储当前无内存缓存（每次直读盘）；保留此钩子供后续任务加入缓存时清空。
 */
export function resetPersonaStoreForTest(): void {
  // no-op until an in-memory cache layer is introduced
}

/**
 * 将 persona Markdown 解析为结构化字段。按 `^## ` 切段，标题命中关键词组即归类；
 * name/summary 取 body 首个非空行；preferences/interactionRules/evolution 按行收集
 * （剥离 `- ` 前缀、丢弃空行）。缺段返回空数组。
 */
export function parsePersonaProfile(md: string): PersonaProfile {
  const profile: PersonaProfile = {
    preferences: [],
    interactionRules: [],
    evolution: []
  };

  const sections = md.split(/^## /m);
  for (let i = 1; i < sections.length; i++) {
    const section = sections[i];
    if (section === undefined) continue;
    const newlineIdx = section.indexOf("\n");
    const title = (newlineIdx === -1 ? section : section.slice(0, newlineIdx)).trim();
    const body = newlineIdx === -1 ? "" : section.slice(newlineIdx + 1);

    if (/(称呼|preferred_name|name|用户)/.test(title)) {
      const name = firstNonEmptyLine(body);
      if (name !== undefined) profile.name = name;
    } else if (/(定位|summary)/.test(title)) {
      const summary = firstNonEmptyLine(body);
      if (summary !== undefined) profile.summary = summary;
    } else if (/(偏好|preference|喜欢)/.test(title)) {
      profile.preferences = parseListBody(body);
    } else if (/(交互|协议|规则|protocol)/.test(title)) {
      profile.interactionRules = parseListBody(body);
    } else if (/(演进|轨迹|evolution)/.test(title)) {
      profile.evolution = parseListBody(body);
    }
  }

  return profile;
}

/**
 * 无 LLM 时的规则兜底：从记忆条目直接拼装最小 persona Markdown。
 * - name：首个 preferred_name claim 的 object
 * - preferences：kind=preference 的前 5 条 statement
 * - interactionRules：带 correction 标签的前 3 条 statement
 * 不输出 summary/evolution（仅 LLM 可生成）。
 * 标题关键词与 parsePersonaProfile 对齐以保证 round-trip。
 */
export function buildPersonaFromRules(entries: MemoryV2Entry[]): string {
  let name: string | undefined;
  for (const entry of entries) {
    const claim = claimFromEntry(entry);
    if (claim?.predicate === MEMORY_CLAIM_PREFERRED_NAME) {
      name = claim.object;
      break;
    }
  }

  const preferences: string[] = [];
  for (const entry of entries) {
    if (entry.frontmatter.kind !== "preference") continue;
    preferences.push(entry.statement);
    if (preferences.length >= 5) break;
  }

  const interactionRules: string[] = [];
  for (const entry of entries) {
    if (!entry.frontmatter.tags.includes("correction")) continue;
    interactionRules.push(entry.statement);
    if (interactionRules.length >= 3) break;
  }

  const lines: string[] = ["# 用户画像"];
  if (name !== undefined) {
    lines.push("", "## 用户（称呼）", name);
  }
  if (preferences.length > 0) {
    lines.push("", "## 长期偏好");
    for (const stmt of preferences) lines.push(`- ${stmt}`);
  }
  if (interactionRules.length > 0) {
    lines.push("", "## 交互协议");
    for (const stmt of interactionRules) lines.push(`- ${stmt}`);
  }
  return lines.join("\n");
}

function firstNonEmptyLine(body: string): string | undefined {
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

// ===========================================================================
// generatePersona：LLM 合成 5 段 persona Markdown
// ===========================================================================

/** LLM 参数：maxTokens / timeoutMs（temperature 未在 SDK CreateMessageParams 暴露，已丢弃） */
const PERSONA_MAX_TOKENS = 4096;
const PERSONA_TIMEOUT_MS = 60_000;

/** 输入 entries 上限（与 analyst.ts 一致） */
const PERSONA_MAX_ENTRIES = 40;

/**
 * Persona 生成系统提示：固定 5 段 Markdown 结构 + 内容约束。
 * - 只用 entries 中明确出现的信息；不推测/不虚构
 * - existing 提供时合并保留稳定内容
 * - 输出纯 Markdown（无围栏、无解释性前缀）
 */
export const PERSONA_SYSTEM_PROMPT = [
  "你是一个用户画像合成助手。基于提供的记忆条目，输出一份简洁、结构化的用户画像 Markdown。",
  "",
  "输出必须严格遵循以下结构（按顺序，缺信息则对应段留空行）：",
  "# 用户画像",
  "## 用户（称呼）        ← 用户希望被称呼的名字（无则留空）",
  "## 一句话定位（≤30字）  ← 一句话概括用户身份/画像",
  "## 长期偏好             ← 每条 10-40 字，用 `- ` 列表",
  "## 交互协议             ← 协作规则/行为纠正（如「不要用 var」），用 `- ` 列表",
  "## 演进轨迹             ← 偏好/状态的演变时间线（如「2026-08 偏好 TS」），用 `- ` 列表",
  "",
  "约束：",
  "- 只使用提供的 entries 中明确出现的信息，绝不推测、脑补或虚构",
  "- 长期偏好每条 10-40 字，不要堆砌、不要重复",
  "- 当提供「已有画像」时，合并保留其中仍然成立、稳定的 content；仅在新证据冲突时更新",
  "- 输出纯 Markdown，不要包裹在代码围栏中，不要添加任何解释性前缀或后缀"
].join("\n");

/** 可注入的 provider 工厂（测试用）：接收 user prompt，返回 LLM 文本响应 */
export type PersonaProviderFactory = (userPrompt: string) => Promise<string>;

/**
 * 用 LLM 合成 persona Markdown。
 *
 * - entries slice 40，每条格式化为 `[kind] statement`（含 claim 时附加）
 * - existing 注入为「已有画像（合并保留稳定内容）」段
 * - 复用 memory-v2 extraction LLM 适配（`resolveMemoryExtractionModelRefs` → provider）
 * - 解析容错：剥离围栏，定位首个 `#`
 * - 失败抛错（caller ensurePersona 捕获 → 规则兜底）
 *
 * `providerFactory` 可注入（测试）；默认工厂复用 extraction provider（生产）。
 */
export async function generatePersona(input: {
  entries: MemoryV2Entry[];
  existing?: string;
  workspaceSlug?: string;
  providerFactory?: PersonaProviderFactory;
}): Promise<string> {
  const factory =
    input.providerFactory ?? createDefaultPersonaProviderFactory(input.workspaceSlug);
  const userPrompt = buildPersonaUserPrompt(input.entries, input.existing);
  const raw = await factory(userPrompt);
  return parsePersonaMarkdown(raw);
}

/**
 * 三态编排：确保 scope 下存在 persona Markdown。
 *
 * 1. 无 persona + LLM 可用 → generatePersona({entries}) → write
 * 2. 有 persona + LLM 可用 → generatePersona({entries, existing}) → write（增量合并）
 * 3. generatePersona 抛错（无模型 / provider 错误）→ buildPersonaFromRules(entries) 兜底 → write
 *
 * - entries 来自 listEntries（markdown-store，按 scope 取）
 * - scope 默认 global；传 workspaceSlug 时默认 workspace
 * - providerFactory 可注入（测试）；默认走 generatePersona 生产工厂
 * - **fail-open**：全程 try/catch，永不抛错（persona 失败不得阻塞 run/feedback）
 */
export async function ensurePersona(input: {
  scope?: MemoryV2Scope;
  workspaceSlug?: string;
  providerFactory?: PersonaProviderFactory;
}): Promise<void> {
  try {
    const scope: MemoryV2Scope = "global";
    const workspaceSlug = undefined;

    const entries = listEntries({ workspaceSlug, scopes: [scope] })
      .filter((entry) => readActivation(entry.frontmatter).persona);
    const existing = readPersonaRaw(scope, workspaceSlug);

    let markdown: string;
    try {
      markdown = await generatePersona({
        entries,
        existing: existing ?? undefined,
        workspaceSlug,
        providerFactory: input.providerFactory
      });
    } catch {
      // LLM 不可用或失败 → 规则兜底
      markdown = buildPersonaFromRules(entries);
    }
    writePersona(scope, workspaceSlug, markdown);
  } catch (error) {
    // fail-open：persona 编排失败不得阻塞调用方
    console.warn("[ensurePersona] persona 编排失败，已忽略:", error);
  }
}

/** 构建 persona 生成 user prompt：记忆条目段 + 已有画像段 */
function buildPersonaUserPrompt(entries: MemoryV2Entry[], existing?: string): string {
  const sections: string[] = [];

  const slice = entries.slice(0, PERSONA_MAX_ENTRIES);
  if (slice.length > 0) {
    sections.push("记忆条目：");
    for (const entry of slice) {
      const kind = entry.frontmatter.kind ?? "unknown";
      const statement = entry.statement ?? "";
      const claim = claimFromEntry(entry);
      const claimText =
        claim !== undefined
          ? ` （claim: ${claim.subject}/${claim.predicate}=${claim.object}）`
          : "";
      sections.push(`- [${kind}] ${statement}${claimText}`);
    }
  } else {
    sections.push("记忆条目：（暂无）");
  }

  if (existing !== undefined && existing.trim().length > 0) {
    sections.push("");
    sections.push("已有画像（合并保留稳定内容）：");
    sections.push(existing.trim());
  }

  return sections.join("\n");
}

/**
 * 解析 LLM 响应为 persona Markdown：剥离围栏，定位首个 `#` 起始位置。
 * 若响应不含 `#`，原样返回（caller 自行处理）。
 */
function parsePersonaMarkdown(raw: string): string {
  let text = raw.trim();
  // 剥离 markdown 围栏（``` / ```markdown / ```md）
  const fenceMatch = text.match(/```(?:markdown|md)?\s*([\s\S]*?)```/);
  if (fenceMatch?.[1]) {
    text = fenceMatch[1].trim();
  }
  // 定位首个 `#`（跳过 LLM 前置解释性文本）
  const hashIdx = text.indexOf("#");
  if (hashIdx > 0) {
    text = text.slice(hashIdx);
  }
  return text.trim();
}

/**
 * 默认 provider 工厂（生产）：复用 memory-v2 extraction LLM 适配。
 * - 模型解析：`resolveMemoryExtractionModelRefs`（同 analyst.ts）
 * - provider 创建：`createLazyConnectionLlmProvider`（基于解析出的 channel binding）
 * - 遍历 fallback modelRefs，首个成功即返回；全部失败抛错
 */
function createDefaultPersonaProviderFactory(
  workspaceSlug?: string
): PersonaProviderFactory {
  return async (userPrompt: string): Promise<string> => {
    const config = getEffectiveLumeConfig(workspaceSlug);
    const modelRefs = resolveMemoryExtractionModelRefs(config, {});
    if (modelRefs.length === 0) {
      throw new Error("[generatePersona] 未配置记忆抽取模型（memory.extraction.modelRef）");
    }

    let lastError: unknown;
    for (const modelRef of modelRefs) {
      try {
        return await callPersonaLlmWithModel({ modelRef, userPrompt });
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("[generatePersona] 所有候选模型均失败");
  };
}

/** 单模型调用：解析 binding → 创建 provider → createMessage → 拼接文本 */
async function callPersonaLlmWithModel(input: {
  modelRef: string;
  userPrompt: string;
}): Promise<string> {
  const binding = resolveChannelModelBinding(input.modelRef, "chat");
  if (!binding) {
    throw new Error(`[generatePersona] 无法解析模型绑定: ${input.modelRef}`);
  }
  const provider: LLMProvider = createLazyConnectionLlmProvider({
    connectionId: binding.channel.id,
    modelId: binding.modelId
  });
  const response = await provider.createMessage({
    model: binding.modelId,
    maxTokens: PERSONA_MAX_TOKENS,
    system: PERSONA_SYSTEM_PROMPT,
    messages: [{ role: "user", content: input.userPrompt }],
    abortSignal: AbortSignal.timeout(PERSONA_TIMEOUT_MS)
  });
  return response.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .filter(Boolean)
    .join("\n");
}

function parseListBody(body: string): string[] {
  const out: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const stripped = trimmed.replace(/^-\s+/, "");
    if (stripped) out.push(stripped);
  }
  return out;
}

function writePersonaAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const hash = createHash("sha1")
    .update(`${path}:${content}:${Date.now()}`)
    .digest("hex")
    .slice(0, 8);
  const tempPath = `${path}.tmp.${hash}`;
  writeFileSync(tempPath, content, "utf-8");
  renameSync(tempPath, path);
}
