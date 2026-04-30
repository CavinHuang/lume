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
  payloadRepeats?: number;
}): string[] {
  const payloadRepeats = Math.max(1, input.payloadRepeats ?? 3);
  return Array.from({ length: input.turnCount }, (_, index) => {
    const turn = index + 1;
    const repeatedPayload = Array.from({ length: payloadRepeats }, (_, payloadIndex) =>
      `payload-${payloadIndex + 1}=这一段用于扩大 transcript 规模并验证 compact 后仍能恢复历史上下文。`
    ).join(" ");
    return [
      `长会话压缩验证 ${input.marker} 第 ${turn} 轮`,
      "请继续保持上下文一致，并把这轮视为 compaction 之前的历史输入。",
      `marker=${input.marker}`,
      `turn=${turn}`,
      repeatedPayload
    ].join(" ");
  });
}

export function assertCompactSmokeOutcome(input: {
  restoredMessages: RestoredMessageLike[];
  compactEvents: CompactEventLike[];
  persistedJsonlContents: string[];
  completedSeedTurns: number;
  compactionSummary: string;
  expectedSeedMarker?: string;
}): void {
  if (input.completedSeedTurns <= 0) {
    throw new Error("seed turns did not complete before compaction");
  }

  if (input.restoredMessages.length === 0) {
    throw new Error("messages not readable after compact restart");
  }

  if (!input.compactEvents.some((event) => event?.type === "compacting")) {
    throw new Error("compacting event missing from runtime notifications");
  }

  if (!input.compactEvents.some((event) => event?.type === "compact_complete")) {
    throw new Error("compact_complete event missing from runtime notifications");
  }

  const joinedPersistedContents = input.persistedJsonlContents.join("\n");
  if (input.expectedSeedMarker) {
    if (!joinedPersistedContents.includes(`marker=${input.expectedSeedMarker}`)) {
      throw new Error("seed marker missing from persisted session files");
    }
    if (!joinedPersistedContents.includes(`turn=${input.completedSeedTurns}`)) {
      throw new Error("latest seed turn missing from persisted session files");
    }
  }

  const hasCompactionEntry = input.persistedJsonlContents.some(
    (content) => content.includes('"type":"compaction"') && content.includes(input.compactionSummary)
  );
  if (!hasCompactionEntry) {
    throw new Error("compaction entry missing from persisted session files");
  }
}
