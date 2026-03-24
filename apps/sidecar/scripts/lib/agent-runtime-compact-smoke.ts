interface RestoredMessageLike {
  role?: string;
  content?: string;
}

interface CompactEventLike {
  type?: string;
}

export function buildLongCompactionSeedMessages(input: {
  turnCount: number;
  marker: string;
}): string[] {
  return Array.from({ length: input.turnCount }, (_, index) => {
    const turn = index + 1;
    return [
      `长会话压缩验证 ${input.marker} 第 ${turn} 轮`,
      "请继续保持上下文一致，并把这轮视为 compaction 之前的历史输入。",
      `marker=${input.marker}`,
      `turn=${turn}`,
      "这一段用于扩大 transcript 规模，确保 compact smoke 覆盖多轮恢复。"
    ].join(" ");
  });
}

export function assertCompactSmokeOutcome(input: {
  restoredMessages: RestoredMessageLike[];
  compactEvents: CompactEventLike[];
  persistedJsonlContents: string[];
  completedSeedTurns: number;
  compactionSummary: string;
}): void {
  if (input.completedSeedTurns <= 0) {
    throw new Error("seed turns did not complete before compaction");
  }

  if (input.restoredMessages.length === 0) {
    throw new Error("messages not readable after compact restart");
  }

  if (!input.compactEvents.some((event) => event?.type === "compacting")) {
    throw new Error("compacting event missing from stream notifications");
  }

  if (!input.compactEvents.some((event) => event?.type === "compact_complete")) {
    throw new Error("compact_complete event missing from stream notifications");
  }

  const hasCompactionEntry = input.persistedJsonlContents.some(
    (content) => content.includes('"type":"compaction"') && content.includes(input.compactionSummary)
  );
  if (!hasCompactionEntry) {
    throw new Error("compaction entry missing from persisted session files");
  }
}
