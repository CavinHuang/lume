/**
 * 观澜(Guanlan)搜索输出的规范化类型与唯一解析器(#531 复审 M2 收敛)。
 *
 * 此前 packages/sdk/tools/web-search 与 sidecar infra 各持一份同构解析且
 * 字段面已分叉——以本超集类型单源化，两侧按需消费；字段缺失时不产生键。
 * 键位兼容: title|name、url|link、snippet|content(合并为 snippet)。
 */
export interface GuanlanSearchItem {
  title: string;
  url: string;
  snippet?: string;
  sourceType?: string;
  evidenceRole?: string;
  domain?: string;
}

export function parseGuanlanSearchItems(output: string): GuanlanSearchItem[] {
  let payload: unknown;
  try {
    payload = JSON.parse(output);
  } catch {
    return [];
  }
  const items = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { results?: unknown[] } | null)?.results)
      ? (payload as { results: unknown[] }).results
      : [];

  return items
    .map(parseGuanlanSearchItem)
    .filter((item): item is GuanlanSearchItem => !!item);
}

function parseGuanlanSearchItem(item: unknown): GuanlanSearchItem | null {
  if (!item || typeof item !== "object") return null;
  const record = item as Record<string, unknown>;
  const title = readTrimmedString(record.title) || readTrimmedString(record.name);
  const url = readTrimmedString(record.url) || readTrimmedString(record.link);
  if (!title || !url) return null;
  const snippet = readTrimmedString(record.snippet) || readTrimmedString(record.content);
  const sourceType = readTrimmedString(record.source_type);
  const evidenceRole = readTrimmedString(record.evidence_role);
  const domain = readTrimmedString(record.domain);
  return {
    title,
    url,
    ...(snippet ? { snippet } : {}),
    ...(sourceType ? { sourceType } : {}),
    ...(evidenceRole ? { evidenceRole } : {}),
    ...(domain ? { domain } : {})
  };
}

function readTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
