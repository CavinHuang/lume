import type { ConversationMeta } from "@lume/shared";

export type DateGroup = "今天" | "昨天" | "更早";

export function groupConversationsByDate<T extends { updatedAt: number }>(
  items: T[],
  now = new Date()
): Array<{ label: DateGroup; items: T[] }> {
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterdayStart = todayStart - 86_400_000;
  const today: T[] = [];
  const yesterday: T[] = [];
  const earlier: T[] = [];

  for (const item of items) {
    if (item.updatedAt >= todayStart) today.push(item);
    else if (item.updatedAt >= yesterdayStart) yesterday.push(item);
    else earlier.push(item);
  }

  const groups: Array<{ label: DateGroup; items: T[] }> = [];
  if (today.length) groups.push({ label: "今天", items: today });
  if (yesterday.length) groups.push({ label: "昨天", items: yesterday });
  if (earlier.length) groups.push({ label: "更早", items: earlier });
  return groups;
}

export function resolveNewConversationPromptId(defaultPromptId?: string | null): string {
  return defaultPromptId ?? "builtin-default";
}

export function sortConversationsByUpdatedAt(conversations: ConversationMeta[]): ConversationMeta[] {
  return [...conversations].sort((a, b) => b.updatedAt - a.updatedAt);
}
