import type { MemoryV2Candidate, MemoryV2Entry, MemoryV2RecallItem } from "./types";
import {
  MEMORY_CLAIM_PREFERRED_NAME,
  MEMORY_CLAIM_SUBJECT_ASSISTANT,
  MEMORY_CLAIM_SUBJECT_USER,
  claimFromEntry,
  inferMemoryV2Claim
} from "./claim";

const PROFILE_TAGS = new Set(["profile", "identity", "preferred-name"]);
const PREFERRED_NAME_RE = /preferred[-_\s]?name|nickname|被称呼|称呼|叫我|喊我|我的名字|我叫|user wants to be called/i;
const WORKSPACE_SCOPE_RE = /(?:这个|当前)?(?:工作区|项目)|workspace|project/i;

export function extractPreferredNameCandidate(input: {
  text: string;
  workspaceSlug?: string;
}): MemoryV2Candidate | undefined {
  const text = input.text.trim();
  const name = extractPreferredName(text);
  if (!name) return undefined;
  const workspaceScoped = WORKSPACE_SCOPE_RE.test(text);
  const statement = workspaceScoped
    ? `用户希望在当前工作区被称呼为 ${name}`
    : `用户希望被称呼为 ${name}`;
  return {
    kind: "preference",
    targetScope: workspaceScoped ? "workspace" : "global",
    statement,
    confidence: "high",
    tags: ["profile", "identity", "preferred-name"],
    entities: [name],
    appliesWhen: workspaceScoped && input.workspaceSlug ? { workspaceSlug: input.workspaceSlug } : {},
    claim: {
      subject: MEMORY_CLAIM_SUBJECT_USER,
      predicate: MEMORY_CLAIM_PREFERRED_NAME,
      object: name
    },
    evidence: {
      quote: text
    }
  };
}

export function extractAssistantPreferredNameCandidate(input: {
  text: string;
  workspaceSlug?: string;
}): MemoryV2Candidate | undefined {
  const text = input.text.trim();
  const name = extractAssistantPreferredName(text);
  if (!name) return undefined;
  const workspaceScoped = WORKSPACE_SCOPE_RE.test(text);
  return {
    kind: "preference",
    targetScope: workspaceScoped ? "workspace" : "global",
    statement: `用户希望用 ${name} 称呼助手`,
    confidence: "high",
    tags: ["profile", "identity", "preferred-name", "self-name"],
    entities: [name],
    appliesWhen: workspaceScoped && input.workspaceSlug ? { workspaceSlug: input.workspaceSlug } : {},
    claim: {
      subject: MEMORY_CLAIM_SUBJECT_ASSISTANT,
      predicate: MEMORY_CLAIM_PREFERRED_NAME,
      object: name
    },
    evidence: {
      quote: text
    }
  };
}

export function isProfileEntry(entry: MemoryV2Entry): boolean {
  if (claimFromEntry(entry)?.predicate === MEMORY_CLAIM_PREFERRED_NAME) return true;
  return isProfileMemory({
    tags: entry.frontmatter.tags,
    statement: entry.statement
  });
}

export function isProfileRecallItem(item: MemoryV2RecallItem): boolean {
  if (item.reason === "profile memory") return true;
  // 与旧 kind 判定等价：kind∈{preference,fact} ⟺ role∉{decision,lesson,state}
  if (item.semanticRole === "decision" || item.semanticRole === "lesson" || item.semanticRole === "state") return false;
  return isPreferredNameMemory({
    statement: item.statement
  });
}

export function isPreferredNameMemory(input: {
  tags?: string[];
  statement: string;
}): boolean {
  if (inferMemoryV2Claim(input)?.predicate === MEMORY_CLAIM_PREFERRED_NAME) return true;
  const tags = new Set((input.tags ?? []).map((tag) => tag.trim().toLowerCase()));
  return tags.has("preferred-name") || PREFERRED_NAME_RE.test(input.statement);
}

export function memoryEntryToRecallItem(entry: MemoryV2Entry, reason = "profile memory"): MemoryV2RecallItem {
  return {
    id: entry.frontmatter.id,
    kind: entry.frontmatter.kind,
    semanticRole: entry.frontmatter.semantic_role,
    scope: entry.frontmatter.scope,
    status: entry.frontmatter.status === "suspected_stale" ? "suspected_stale" : "active",
    statement: entry.statement,
    path: entry.path,
    citation: entry.path,
    reason,
    score: 100,
    pinned: entry.frontmatter.pinned,
    tags: entry.frontmatter.tags,
    claim: claimFromEntry(entry)
  };
}

function isProfileMemory(input: {
  tags?: string[];
  statement: string;
}): boolean {
  const tags = new Set((input.tags ?? []).map((tag) => tag.trim().toLowerCase()));
  if ([...PROFILE_TAGS].some((tag) => tags.has(tag))) return true;
  return PREFERRED_NAME_RE.test(input.statement);
}

function extractAssistantPreferredName(text: string): string | undefined {
  const patterns = [
    /(?:就想|想|希望|以后)?(?:叫你|称呼你|喊你|叫你为|称呼你为|喊你为)\s*([^\s，。！？,!.]+)\s*$/i,
    /(?:就想|想|希望)(?:用|把你叫作|把你叫做)\s*([^\s，。！？,!.]+)(?:\s*称呼你|\s*叫你)?\s*$/i,
    /(?:不要|别)?叫你\s*[^\s，。！？,!.]+\s*(?:了)?[，,]?\s*(?:叫你|叫)\s*([^\s，。！？,!.]+)\s*$/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const name = match?.[1]?.trim();
    if (name && !/什么|谁|what|who/i.test(name)) return name;
  }
  return undefined;
}

function extractPreferredName(text: string): string | undefined {
  const patterns = [
    /(?:在(?:这个|当前)?(?:工作区|项目)(?:里)?\s*)?(?:以后)?(?:叫我|称呼我|喊我)\s*([^\s，。！？,!.]+)\s*$/i,
    /(?:my name is|call me)\s+([^\s，。！？,!.]+)\s*$/i,
    /我(?:的)?名字(?:是|叫)\s*([^\s，。！？,!.]+)\s*$/i,
    /我叫\s*([^\s，。！？,!.]+)\s*$/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const name = match?.[1]?.trim();
    if (name && !/什么|谁|what|who/i.test(name)) return name;
  }
  return undefined;
}
