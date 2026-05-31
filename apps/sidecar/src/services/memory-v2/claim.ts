import type {
  MemoryV2Claim,
  MemoryV2Entry,
  MemoryV2RecallItem,
  MemoryV2Scope
} from "./types";

export const MEMORY_CLAIM_SUBJECT_USER = "user/self";
export const MEMORY_CLAIM_SUBJECT_ASSISTANT = "assistant/self";
export const MEMORY_CLAIM_SUBJECT_WORKSPACE = "workspace/default";

export const MEMORY_CLAIM_PREFERRED_NAME = "preferred_name";
export const MEMORY_CLAIM_IDENTITY = "identity";
export const MEMORY_CLAIM_PREFERENCE = "preference";
export const MEMORY_CLAIM_WRITING_STYLE = "writing_style";
export const MEMORY_CLAIM_SOURCE_OF_TRUTH = "source_of_truth";

export interface MemoryV2QueryPlan {
  querySubject?: string;
  desiredPredicates: string[];
  includeConversationHistory: boolean;
}

export function normalizeMemoryV2Claim(value: unknown): MemoryV2Claim | undefined {
  if (!isRecord(value)) return undefined;
  const subject = normalizeClaimPart(value.subject);
  const predicate = normalizeClaimPart(value.predicate);
  const object = normalizeClaimObject(value.object);
  if (!subject || !predicate || !object) return undefined;
  const qualifiers = normalizeStringRecord(value.qualifiers);
  return {
    subject,
    predicate,
    object,
    ...(qualifiers ? { qualifiers } : {})
  };
}

export function inferMemoryV2Claim(input: {
  statement: string;
  tags?: string[];
}): MemoryV2Claim | undefined {
  const statement = input.statement.trim();
  if (!statement) return undefined;
  const tags = new Set((input.tags ?? []).map((tag) => tag.trim().toLowerCase()));
  const taggedSelfName = tags.has("self-name") || tags.has("assistant-name");
  const assistantName = extractFirst(statement, [
    /用户希望(?:用|把助手称为|称呼助手为|称呼你为|叫你)\s*["“]([^"”]+)["”]\s*(?:称呼助手|称呼你|称呼)?/i,
    /用户希望(?:用|把助手称为|称呼助手为|称呼你为|叫你)\s*([^\s，。！？,!.]+)\s*(?:称呼助手|称呼你|称呼)?/i,
    /用户希望(?:我|助手)(?:自称|被称呼为|叫作|叫做|叫)\s*([^\s，。！？,!.]+)/i,
    /user wants (?:the )?assistant to be called\s+([^\s，。！？,!.]+)/i,
    /assistant preferred[-_\s]?name(?: is|:)?\s*([^\s，。！？,!.]+)/i
  ]);
  if (assistantName && (taggedSelfName || /助手|assistant|自称|叫你|称呼你/.test(statement))) {
    return {
      subject: MEMORY_CLAIM_SUBJECT_ASSISTANT,
      predicate: MEMORY_CLAIM_PREFERRED_NAME,
      object: assistantName
    };
  }

  const userName = extractFirst(statement, [
    /用户希望(?:在当前工作区)?被(?:称呼|叫|喊)(?:为)?\s*["“]([^"”]+)["”]/i,
    /用户希望(?:在当前工作区)?被(?:称呼|叫|喊)(?:为)?\s*([^\s，。！？,!.]+)/i,
    /用户(?:的)?(?:名字|称呼)(?:是|叫)?\s*([^\s，。！？,!.]+)/i,
    /user wants to be called\s+([^\s，。！？,!.]+)/i,
    /user preferred[-_\s]?name(?: is|:)?\s*([^\s，。！？,!.]+)/i
  ]);
  if (userName) {
    return {
      subject: MEMORY_CLAIM_SUBJECT_USER,
      predicate: MEMORY_CLAIM_PREFERRED_NAME,
      object: userName
    };
  }

  const writingStyle = extractWritingStyle(statement, tags);
  if (writingStyle) {
    return {
      subject: MEMORY_CLAIM_SUBJECT_USER,
      predicate: MEMORY_CLAIM_WRITING_STYLE,
      object: writingStyle
    };
  }

  const sourceOfTruth = extractSourceOfTruth(statement);
  if (sourceOfTruth) {
    return {
      subject: MEMORY_CLAIM_SUBJECT_WORKSPACE,
      predicate: MEMORY_CLAIM_SOURCE_OF_TRUTH,
      object: sourceOfTruth
    };
  }
  return undefined;
}

export function claimFromEntry(entry: MemoryV2Entry): MemoryV2Claim | undefined {
  return entry.frontmatter.claim ?? inferMemoryV2Claim({
    statement: entry.statement,
    tags: entry.frontmatter.tags
  });
}

export function claimKey(input: {
  scope: MemoryV2Scope;
  claim: MemoryV2Claim;
  appliesWhen?: Record<string, string>;
}): string {
  return [
    input.scope,
    normalizeKeyPart(input.claim.subject),
    normalizeKeyPart(input.claim.predicate),
    stableStringify(input.appliesWhen ?? {})
  ].join("|");
}

export function claimObjectEquals(left: MemoryV2Claim, right: MemoryV2Claim): boolean {
  return normalizeObjectForCompare(left.object) === normalizeObjectForCompare(right.object);
}

export function planMemoryV2Query(query: string): MemoryV2QueryPlan {
  const text = query.trim().toLowerCase();
  const includeConversationHistory = /之前|上次|历史|聊过|问过|做过|最近|当前|现在|刚才|干嘛|做什么|做到哪|继续|进展|状态|history|previous|before|recent|current|now|continue|status/i.test(text);
  const workspaceScoped = /工作区|项目|记忆系统|事实源|真实数据源|source of truth|workspace|project/.test(text);
  if (/你是谁|你叫什么|你叫啥|怎么称呼你|你的名字|who are you|what(?:'s| is) your name/.test(text)) {
    return {
      querySubject: MEMORY_CLAIM_SUBJECT_ASSISTANT,
      desiredPredicates: [MEMORY_CLAIM_PREFERRED_NAME, MEMORY_CLAIM_IDENTITY],
      includeConversationHistory
    };
  }
  if (/我是谁|我叫什么|我的名字|叫我什么|怎么称呼我|who am i|what(?:'s| is) my name/.test(text)) {
    return {
      querySubject: MEMORY_CLAIM_SUBJECT_USER,
      desiredPredicates: [MEMORY_CLAIM_PREFERRED_NAME, MEMORY_CLAIM_IDENTITY],
      includeConversationHistory
    };
  }
  if (/写作风格|文风|语气|表达风格|措辞|行文|writing style|voice|tone/.test(text)) {
    return {
      querySubject: MEMORY_CLAIM_SUBJECT_USER,
      desiredPredicates: [MEMORY_CLAIM_WRITING_STYLE, MEMORY_CLAIM_PREFERENCE],
      includeConversationHistory
    };
  }
  if (/偏好|喜欢|默认|习惯|prefer|preference|default|habit/.test(text)) {
    return {
      querySubject: workspaceScoped
        ? MEMORY_CLAIM_SUBJECT_WORKSPACE
        : /你|assistant|your/.test(text) && !/我|我的|my|user/.test(text)
        ? MEMORY_CLAIM_SUBJECT_ASSISTANT
        : MEMORY_CLAIM_SUBJECT_USER,
      desiredPredicates: [MEMORY_CLAIM_PREFERENCE],
      includeConversationHistory
    };
  }
  if (workspaceScoped) {
    return {
      querySubject: MEMORY_CLAIM_SUBJECT_WORKSPACE,
      desiredPredicates: [MEMORY_CLAIM_SOURCE_OF_TRUTH, "decision", "fact", MEMORY_CLAIM_PREFERENCE],
      includeConversationHistory
    };
  }
  return {
    desiredPredicates: [],
    includeConversationHistory
  };
}

export function isClaimMatchForQuery(item: Pick<MemoryV2RecallItem, "claim">, plan: MemoryV2QueryPlan): boolean {
  if (!item.claim || !plan.querySubject || plan.desiredPredicates.length === 0) return false;
  return normalizeKeyPart(item.claim.subject) === normalizeKeyPart(plan.querySubject)
    && plan.desiredPredicates.some((predicate) => normalizeKeyPart(predicate) === normalizeKeyPart(item.claim!.predicate));
}

export function sortClaimMatchesFirst(items: MemoryV2RecallItem[], plan: MemoryV2QueryPlan): MemoryV2RecallItem[] {
  return [...items].sort((a, b) => {
    const aClaim = isClaimMatchForQuery(a, plan) ? 1 : 0;
    const bClaim = isClaimMatchForQuery(b, plan) ? 1 : 0;
    if (aClaim !== bClaim) return bClaim - aClaim;
    if (aClaim && bClaim) {
      const predicateOrder = claimPredicateRank(a, plan) - claimPredicateRank(b, plan);
      if (predicateOrder !== 0) return predicateOrder;
    }
    return b.score - a.score;
  });
}

function claimPredicateRank(item: Pick<MemoryV2RecallItem, "claim">, plan: MemoryV2QueryPlan): number {
  if (!item.claim) return Number.MAX_SAFE_INTEGER;
  const normalized = normalizeKeyPart(item.claim.predicate);
  const index = plan.desiredPredicates.findIndex((predicate) => normalizeKeyPart(predicate) === normalized);
  return index >= 0 ? index : Number.MAX_SAFE_INTEGER;
}

function extractFirst(value: string, patterns: RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const name = value.match(pattern)?.[1]?.trim();
    if (name && !/什么|谁|what|who/i.test(name)) return stripNameNoise(name);
  }
  return undefined;
}

function extractWritingStyle(value: string, tags: Set<string>): string | undefined {
  if (!tags.has("voice") && !tags.has("writing-style") && !/写作风格|文风|语气|表达风格|措辞|行文|writing style|voice|tone/i.test(value)) {
    return undefined;
  }
  return extractFirst(value, [
    /(?:我|用户)(?:的)?(?:写作风格|文风|表达风格|语气)(?:是|偏好|喜欢|为|:|：)?\s*([^。！？\n]+)/i,
    /用户(?:的)?(?:写作风格|文风|表达风格|语气)(?:是|偏好|喜欢|为|:|：)?\s*([^。！？\n]+)/i,
    /(?:我|用户)(?:写作|表达|回复)(?:时)?(?:偏好|喜欢|习惯)\s*([^。！？\n]+)/i,
    /user (?:writing style|voice|tone)(?: is|:)?\s*([^.!?\n]+)/i,
    /user prefers\s*([^.!?\n]+?)\s*(?:writing|tone|voice|style)/i
  ]) ?? (tags.has("voice") || tags.has("writing-style") ? value : undefined);
}

function extractSourceOfTruth(value: string): string | undefined {
  return extractFirst(value, [
    /(?:使用|以|用)\s*([^，。！？,!.]+?)\s*作为(?:事实源|真实数据源|source of truth)/i,
    /(?:事实源|真实数据源|source of truth)(?:是|为|:|：|\s+is\s+)\s*([^，。！？,!.]+)/i,
    /([^，。！？,!.]+?)\s*(?:是|is)\s*[^，。！？,!.]*(?:事实源|真实数据源|source of truth)/i
  ]);
}

function stripNameNoise(value: string): string {
  return value
    .replace(/^(?:为|叫作|叫做|叫)/, "")
    .replace(/^["“”]+|["“”]+$/g, "")
    .replace(/[。！？,!.]+$/g, "")
    .trim();
}

function normalizeClaimPart(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeClaimObject(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return undefined;
  const trimmed = String(value).trim();
  return trimmed ? trimmed : undefined;
}

function normalizeStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    if (typeof rawValue !== "string") continue;
    const normalizedKey = key.trim();
    const normalizedValue = rawValue.trim();
    if (normalizedKey && normalizedValue) out[normalizedKey] = normalizedValue;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function stableStringify(value: Record<string, string>): string {
  return JSON.stringify(Object.keys(value).sort().map((key) => [key, value[key]]));
}

function normalizeKeyPart(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeObjectForCompare(value: string): string {
  return value.trim().toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
