import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { WikiLintFinding, WikiSnapshot } from "@lume/shared";
import { ensureWikiDirectory, resolveWikiPath } from "./path-security";

const WEEK_MS = 7 * 24 * 60 * 60 * 1_000;

type PersistedSemanticCheck = WikiSnapshot["semanticCheck"] & {
  lastAttemptAt?: string;
  lastAttemptGeneration?: number;
  findingCounts?: Record<WikiLintFinding["severity"], number>;
};

export class WikiHealthStore {
  constructor(readonly root: string, private readonly now: () => number = Date.now) {}

  evaluate(generation: number, findings: WikiLintFinding[]): WikiSnapshot["semanticCheck"] {
    const current = this.read();
    if (!current.enabled) return current;
    const lastSuccessful = current.lastSuccessfulAt ? Date.parse(current.lastSuccessfulAt) : 0;
    const due = !lastSuccessful || this.now() - lastSuccessful >= WEEK_MS;
    if (!due) return current;
    if (current.lastAttemptGeneration === generation) return current;

    // Phase A has no semantic model runner. Persisting the attempt prevents every
    // Wiki open from enqueuing the same unavailable check for one generation.
    const next: PersistedSemanticCheck = {
      enabled: true,
      status: "unavailable",
      lastSuccessfulAt: current.lastSuccessfulAt,
      lastAttemptAt: new Date(this.now()).toISOString(),
      lastAttemptGeneration: generation,
      findingCounts: countFindings(findings),
      message: "本 generation 的结构检查已完成；未配置 Wiki 语义模型，因此语义检查未执行。",
    };
    this.write(next);
    return next;
  }

  private read(): PersistedSemanticCheck {
    const path = this.path();
    if (!existsSync(path)) return { enabled: true, status: "never", message: "尚未运行语义检查。" };
    return JSON.parse(readFileSync(path, "utf8")) as PersistedSemanticCheck;
  }

  private write(state: PersistedSemanticCheck): void {
    const path = this.path();
    const temporary = resolveWikiPath(this.root, `.lume/health/semantic-check.${randomUUID()}.tmp`);
    writeFileSync(temporary, JSON.stringify(state, null, 2), { encoding: "utf8", flag: "wx" });
    renameSync(temporary, path);
  }

  private path(): string {
    ensureWikiDirectory(this.root, ".lume/health");
    return resolveWikiPath(this.root, ".lume/health/semantic-check.json");
  }
}

function countFindings(findings: WikiLintFinding[]): Record<WikiLintFinding["severity"], number> {
  return findings.reduce<Record<WikiLintFinding["severity"], number>>(
    (counts, finding) => ({ ...counts, [finding.severity]: counts[finding.severity] + 1 }),
    { info: 0, warning: 0, error: 0 },
  );
}
