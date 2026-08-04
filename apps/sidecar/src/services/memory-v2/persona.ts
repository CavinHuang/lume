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
import type { PersonaProfile } from "@lume/shared";
import { getPersonaPath } from "./paths";
import type { MemoryV2Scope } from "./types";

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

function firstNonEmptyLine(body: string): string | undefined {
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
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
