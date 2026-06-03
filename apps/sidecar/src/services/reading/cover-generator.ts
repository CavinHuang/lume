import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { getReadingCoversDir } from "../infra/config-paths";
import {
  listReadingBooks,
  setReadingBookLocalCover
} from "./reading-store";

export interface ReadingGenerateCoverInput {
  bookId: string;
}

export interface ReadingGenerateCoverResult {
  ok: true;
  bookId: string;
  path: string;
  createdAt: number;
}

export function generateReadingCover(input: ReadingGenerateCoverInput): ReadingGenerateCoverResult {
  const book = listReadingBooks().find((item) => item.id === input.bookId);
  if (!book) {
    throw new Error(`读书书籍不存在: ${input.bookId}`);
  }
  const createdAt = Date.now();
  const path = join(getReadingCoversDir(), `${safeFileSegment(book.id)}-${createdAt}.svg`);
  writeFileSync(path, buildCoverSvg({
    title: book.title,
    author: book.author,
    tags: book.tags,
    sourceKind: book.source.kind,
    createdAt
  }), "utf-8");
  setReadingBookLocalCover(book.id, path);
  return {
    ok: true,
    bookId: book.id,
    path,
    createdAt
  };
}

function buildCoverSvg(input: {
  title: string;
  author?: string;
  tags: string[];
  sourceKind: string;
  createdAt: number;
}): string {
  const palette = selectPalette(input.sourceKind);
  const titleLines = wrapText(input.title, 8, 4);
  const tagLine = input.tags.slice(0, 3).join(" · ") || "Lume 在读";
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="720" height="1040" viewBox="0 0 720 1040">
  <metadata>${escapeXml(JSON.stringify({ generatedAt: input.createdAt, source: "lume-reading-cover" }))}</metadata>
  <rect width="720" height="1040" fill="${palette.background}"/>
  <rect x="54" y="54" width="612" height="932" rx="28" fill="${palette.paper}" stroke="${palette.stroke}" stroke-width="2"/>
  <rect x="102" y="112" width="516" height="3" fill="${palette.accent}"/>
  <text x="102" y="188" fill="${palette.accent}" font-size="24" font-weight="700">Lume Reading</text>
  ${titleLines.map((line, index) => `<text x="102" y="${322 + index * 72}" fill="${palette.text}" font-size="58" font-weight="800">${escapeXml(line)}</text>`).join("\n  ")}
  <text x="102" y="672" fill="${palette.muted}" font-size="28">${escapeXml(input.author ?? "Lume 自主阅读")}</text>
  <rect x="102" y="752" width="516" height="1" fill="${palette.stroke}"/>
  <text x="102" y="820" fill="${palette.accent}" font-size="24">${escapeXml(tagLine)}</text>
  <text x="102" y="910" fill="${palette.muted}" font-size="18">AI 生成封面，用于本地读书卡片展示</text>
</svg>
`;
}

function selectPalette(sourceKind: string): {
  background: string;
  paper: string;
  stroke: string;
  accent: string;
  text: string;
  muted: string;
} {
  if (sourceKind === "poetry") {
    return {
      background: "#edf3ee",
      paper: "#fbfdf9",
      stroke: "#c8d6c7",
      accent: "#44735a",
      text: "#1f3026",
      muted: "#708174"
    };
  }
  if (sourceKind === "gutenberg") {
    return {
      background: "#edf1f6",
      paper: "#fbfcff",
      stroke: "#c7d0dc",
      accent: "#486f9d",
      text: "#202b38",
      muted: "#6d7885"
    };
  }
  return {
    background: "#f4efe6",
    paper: "#fffdf8",
    stroke: "#dfd0ba",
    accent: "#9b6f38",
    text: "#29241d",
    muted: "#83786a"
  };
}

function wrapText(value: string, lineLength: number, maxLines: number): string[] {
  const normalized = value.trim();
  const lines: string[] = [];
  for (let index = 0; index < normalized.length && lines.length < maxLines; index += lineLength) {
    lines.push(normalized.slice(index, index + lineLength));
  }
  return lines.length ? lines : ["未命名书籍"];
}

function safeFileSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-");
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
