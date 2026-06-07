export const AFTERGLOW_MARKER = "⟡";
export const AFTERGLOW_LINE_RE = /^(?:\s*[-*+]\s*)?⟡\s*(.+)$/;

export type AfterglowBlock =
  | { type: "markdown"; text: string }
  | { type: "afterglow"; text: string };

export type AfterglowLineMatch =
  | { matched: true; text: string }
  | { matched: false };

export function isAfterglowLine(line: string): AfterglowLineMatch {
  const match = line.match(AFTERGLOW_LINE_RE);
  if (!match) return { matched: false };
  const text = match[1]?.trim() ?? "";
  return text ? { matched: true, text } : { matched: false };
}

export function parseAfterglowBlocks(text: string): AfterglowBlock[] {
  const blocks: AfterglowBlock[] = [];
  const markdownLines: string[] = [];
  let inFence = false;
  let fenceMarker: "```" | "~~~" | null = null;

  const flushMarkdown = () => {
    if (markdownLines.length === 0) return;
    blocks.push({ type: "markdown", text: markdownLines.join("\n") });
    markdownLines.length = 0;
  };

  for (const line of text.split("\n")) {
    const trimmed = line.trimStart();

    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      const marker = trimmed.startsWith("```") ? "```" : "~~~";
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (fenceMarker === marker) {
        inFence = false;
        fenceMarker = null;
      }
      markdownLines.push(line);
      continue;
    }

    const afterglow = inFence ? { matched: false } as const : isAfterglowLine(line);
    if (afterglow.matched) {
      flushMarkdown();
      blocks.push({ type: "afterglow", text: afterglow.text });
      continue;
    }

    markdownLines.push(line);
  }

  flushMarkdown();
  return blocks;
}

export function stripAfterglowLines(text: string): string {
  return parseAfterglowBlocks(text)
    .filter((block): block is Extract<AfterglowBlock, { type: "markdown" }> => block.type === "markdown")
    .map((block) => block.text)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
