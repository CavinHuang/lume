import type { MemoryV2Candidate } from "./types";

const DO_NOT_REMEMBER_RE = /\bdo not remember\b|\bdon't remember\b|\bdo not save\b|不要记住|别记住|不要保存/i;

export function extractExplicitMemoryCandidates(input: {
  text: string;
  workspaceSlug?: string;
}): MemoryV2Candidate[] {
  const text = input.text.trim();
  if (!text || DO_NOT_REMEMBER_RE.test(text)) return [];

  const statement = extractStatement(text);
  if (!statement) return [];
  const kind = inferKind(text, statement);
  const targetScope = kind === "preference" ? "global" : "workspace";
  return [{
    kind,
    targetScope,
    statement,
    confidence: "high",
    tags: inferTags(text),
    entities: inferEntities(text),
    appliesWhen: targetScope === "workspace" && input.workspaceSlug
      ? { workspaceSlug: input.workspaceSlug }
      : {},
    evidence: {
      quote: text
    }
  }];
}

function extractStatement(text: string): string | undefined {
  const patterns = [
    /(?:^|\b)remember(?: that)?[:：]?\s+([\s\S]+)$/i,
    /(?:^|\b)please remember[:：]?\s+([\s\S]+)$/i,
    /记住[:：]?\s*([\s\S]+)$/i,
    /以后[:：]?\s*([\s\S]+)$/i,
    /(?:^|\b)i prefer\s+([\s\S]+)$/i,
    /(?:^|\b)prefer\s+([\s\S]+)$/i,
    /我(?:更)?(?:喜欢|偏好)\s*([\s\S]+)$/i,
    /(?:^|\b)actually[:：]?\s+([\s\S]+)$/i,
    /(?:不对|错了)[:：]?\s*([\s\S]+)$/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const candidate = match?.[1]?.trim();
    if (candidate) return stripTrailingNoise(candidate);
  }
  return undefined;
}

function inferKind(text: string, statement: string): MemoryV2Candidate["kind"] {
  const combined = `${text}\n${statement}`.toLowerCase();
  if (/prefer|以后|喜欢|偏好|默认|习惯/.test(combined)) return "preference";
  if (/actually|不对|错了|correction|correct/.test(combined)) return "fact";
  return "fact";
}

function inferTags(text: string): string[] {
  const tags = ["explicit-intent"];
  if (/memory|记忆/.test(text)) tags.push("memory");
  if (/workflow|commit|push|提交|推送/.test(text)) tags.push("workflow");
  return tags;
}

function inferEntities(text: string): string[] {
  const entities: string[] = [];
  if (/lume/i.test(text)) entities.push("Lume");
  return entities;
}

function stripTrailingNoise(value: string): string {
  return value
    .replace(/\s*(?:thanks|谢谢|。|！|!)+$/i, "")
    .trim();
}
