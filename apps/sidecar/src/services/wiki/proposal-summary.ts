import type { WikiChangeDraft, WikiProposalSummaryV1 } from "@lume/shared";
import { sha256 } from "./markdown-store";

const MAX_PREVIEW_CHARS = 2_000;
const MAX_PREVIEWS = 20;

export function createWikiProposalSummary(draft: WikiChangeDraft): WikiProposalSummaryV1 {
  return {
    schemaVersion: 1,
    draftId: draft.id,
    revision: draft.revision,
    expiresAt: draft.expiresAt,
    risk: draft.risk,
    reasons: [...draft.riskReasons],
    title: draft.title,
    operationSummaries: draft.operations.map((operation) => ({
      kind: operation.kind,
      ...(operation.contentMutation ? { contentMutationKind: operation.contentMutation.kind } : {}),
      pageId: operation.pageId,
      beforeHash: operation.beforeHash,
      targetRelativePath: operation.targetRelativePath,
    })),
    boundedDiffPreviews: draft.diffs.slice(0, MAX_PREVIEWS).map((diff) => ({
      pageId: diff.pageId,
      path: diff.path,
      preview: diff.preview.slice(0, MAX_PREVIEW_CHARS),
    })),
    diffHash: computeWikiDraftDiffHash(draft),
  };
}

export function computeWikiDraftDiffHash(draft: WikiChangeDraft): string {
  return sha256(canonicalJson({
    schemaVersion: 1,
    operations: draft.operations.map((operation) => ({
      kind: operation.kind,
      pageId: operation.pageId,
      beforeHash: operation.beforeHash,
      targetRelativePath: operation.targetRelativePath,
      previousRelativePath: operation.previousRelativePath ?? null,
      markdownHash: operation.markdown ? sha256(operation.markdown) : null,
      contentMutation: operation.contentMutation ?? null,
    })),
    sources: draft.sources.map((source) => ({
      sourceId: source.manifest.id,
      contentHash: source.manifest.content_hash,
      blobHash: source.manifest.blob_hash ?? null,
      grants: [...source.grants].sort(),
    })),
    privacyPurgeSourceIds: [...(draft.privacyPurgeSourceIds ?? [])].sort(),
  }));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}
