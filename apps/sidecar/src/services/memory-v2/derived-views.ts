import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { claimFromEntry } from "./claim";
import { createMemoryV2Store } from "./markdown-store";
import { ensurePersona } from "./persona";
import { getMemoryV2ScopePaths } from "./paths";
import type { MemoryV2Entry, MemoryV2Scope } from "./types";

const rebuildTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function scheduleDerivedMemoryRebuild(input: { scope: MemoryV2Scope; workspaceSlug?: string }): void {
  const key = `${input.scope}:${input.workspaceSlug ?? "global"}`;
  const configDir = process.env.LUME_CONFIG_DIR;
  const current = rebuildTimers.get(key);
  if (current) clearTimeout(current);
  rebuildTimers.set(key, setTimeout(() => {
    rebuildTimers.delete(key);
    if (process.env.LUME_CONFIG_DIR !== configDir) return;
    void rebuildDerivedMemoryViews(input).catch(() => undefined);
  }, 500));
}

export async function rebuildDerivedMemoryViews(input: { scope: MemoryV2Scope; workspaceSlug?: string }): Promise<void> {
  const paths = getMemoryV2ScopePaths({ scope: input.scope, workspaceSlug: input.workspaceSlug });
  const entries = createMemoryV2Store().listEntries({
    workspaceSlug: input.workspaceSlug,
    scopes: [input.scope],
    includeStatuses: ["active", "suspected_stale"]
  });
  rebuildMemoryIndex(paths.memoryMd, input.scope, entries);
  rebuildCapsules(paths.capsulesDir, input.scope, entries);
  if (input.scope === "workspace") {
    rebuildWorkspaceBrief(paths.workspaceBrief, entries);
  } else {
    await ensurePersona({ scope: "global" });
  }
}

function rebuildMemoryIndex(path: string, scope: MemoryV2Scope, entries: MemoryV2Entry[]): void {
  const active = entries.filter((entry) => entry.frontmatter.status === "active");
  const lines = [
    `# ${scope === "global" ? "Global" : "Workspace"} Memory`,
    "",
    "> Derived index. Atomic entry files remain the source of truth.",
    "",
    ...active.map((entry) => `- [${entry.frontmatter.id}] ${entry.statement}`),
    ""
  ];
  writeAtomic(path, lines.join("\n"));
}

function rebuildCapsules(dir: string, scope: MemoryV2Scope, entries: MemoryV2Entry[]): void {
  const groups = new Map<string, MemoryV2Entry[]>();
  for (const entry of entries.filter((item) => item.frontmatter.status === "active")) {
    const claim = claimFromEntry(entry);
    const key = claim
      ? `${claim.subject}/${claim.predicate}`
      : entry.frontmatter.facets[0] ?? entry.frontmatter.entities[0] ?? "general";
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }
  const nextNames = new Set<string>();
  for (const [topic, group] of groups) {
    if (group.length < 2) continue;
    const name = `${safeName(topic)}-${createHash("sha1").update(topic).digest("hex").slice(0, 8)}.md`;
    nextNames.add(name);
    const claimIds = group.map((entry) => entry.frontmatter.id);
    const keywords = Array.from(new Set(group.flatMap((entry) => [...entry.frontmatter.facets, ...entry.frontmatter.entities]))).slice(0, 12);
    const frontmatter = {
      title: topic,
      scope,
      claim_ids: claimIds,
      keywords,
      updated_at: new Date().toISOString()
    };
    writeAtomic(join(dir, name), `---\n${YAML.stringify(frontmatter).trimEnd()}\n---\n# ${topic}\n\n${group.map((entry) => `- ${entry.statement}`).join("\n")}\n`);
  }
  for (const name of readdirSync(dir)) {
    if (name.endsWith(".md") && !nextNames.has(name)) rmSync(join(dir, name), { force: true });
  }
}

function rebuildWorkspaceBrief(path: string, entries: MemoryV2Entry[]): void {
  const eligible = entries.filter((entry) =>
    entry.frontmatter.status === "active"
    && ["constraint", "decision", "lesson", "fact", "preference"].includes(entry.frontmatter.semantic_role)
    && !/\b(?:todo|next step|in progress|pending task)\b|待办|下一步|进行中|未完成/i.test(entry.statement)
  );
  const groups = [
    ["稳定约束", eligible.filter((entry) => entry.frontmatter.semantic_role === "constraint")],
    ["已确认决策", eligible.filter((entry) => entry.frontmatter.semantic_role === "decision")],
    ["协作方式", eligible.filter((entry) => entry.frontmatter.semantic_role === "preference")],
    ["验证过的经验与事实", eligible.filter((entry) => entry.frontmatter.semantic_role === "lesson" || entry.frontmatter.semantic_role === "fact")]
  ] as const;
  const lines = ["# Workspace Brief", "", "> Derived view. Tasks and next steps intentionally live in the task system.", ""];
  for (const [title, group] of groups) {
    if (group.length === 0) continue;
    lines.push(`## ${title}`, "", ...group.slice(0, 12).map((entry) => `- ${entry.statement}`), "");
  }
  writeAtomic(path, `${lines.join("\n").trim()}\n`);
}

function safeName(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 48) || "topic";
}

function writeAtomic(path: string, content: string): void {
  const current = existsSync(path) ? readFileSync(path, "utf-8") : undefined;
  if (current === content) return;
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, content, "utf-8");
  renameSync(temp, path);
}
