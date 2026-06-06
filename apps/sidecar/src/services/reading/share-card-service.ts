import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ReadingGenerateShareCardInput, ReadingShareCardResult } from "@lume/shared";
import { getReadingShareCardsDir } from "../infra/config-paths";
import {
  getReadingNote,
  setReadingNoteShareCard
} from "./reading-store";

export function generateReadingShareCard(input: ReadingGenerateShareCardInput): ReadingShareCardResult {
  const note = getReadingNote(input.noteId);
  if (!note || note.deleted) {
    throw new Error(`读书笔记不存在: ${input.noteId}`);
  }
  const createdAt = Date.now();
  const path = input.outputPath?.trim() || join(getReadingShareCardsDir(), `${safeFileSegment(note.id)}-${createdAt}.svg`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buildShareCardSvg({
    noteId: note.id,
    bookTitle: note.book?.title ?? note.title,
    author: note.book?.author,
    coverHref: toSvgImageHref(note.book?.localCoverPath ?? note.book?.coverUrl),
    content: note.body,
    tags: note.tags,
    createdAt
  }), "utf-8");
  setReadingNoteShareCard(note.id, path);
  return {
    noteId: note.id,
    path,
    createdAt
  };
}

function buildShareCardSvg(input: {
  noteId: string;
  bookTitle: string;
  author?: string;
  coverHref?: string;
  content: string;
  tags: string[];
  createdAt: number;
}): string {
  const content = wrapText(input.content, 22, 8);
  const tags = input.tags.slice(0, 4).join(" · ");
  const cover = input.coverHref
    ? `<image href="${escapeXml(input.coverHref)}" x="52" y="76" width="126" height="168" preserveAspectRatio="xMidYMid slice" />`
    : `<rect x="52" y="76" width="126" height="168" rx="8" fill="#e8e3d8" /><text x="115" y="174" text-anchor="middle" fill="#9b7a46" font-size="42" font-weight="500">${escapeXml(bookInitial(input.bookTitle))}</text>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="720" height="960" viewBox="0 0 720 960">
  <metadata>${escapeXml(JSON.stringify({ sourceNoteId: input.noteId, generatedAt: input.createdAt }))}</metadata>
  <defs>
    <clipPath id="reading-share-card-content-clip">
      <rect x="52" y="350" width="616" height="300" />
    </clipPath>
  </defs>
  <rect width="720" height="960" fill="#f4efe6"/>
  <rect x="36" y="36" width="648" height="888" rx="22" fill="#fffdf8" stroke="#e4d8c5"/>
  ${cover}
  <text x="214" y="104" fill="#25221e" font-size="30" font-weight="700">${escapeXml(truncate(input.bookTitle, 18))}</text>
  <text x="214" y="146" fill="#9b7a46" font-size="18">${escapeXml(input.author ?? "Lume 在读")}</text>
  <text x="52" y="316" fill="#9b7a46" font-size="20" font-weight="700">读书笔记</text>
  <g clip-path="url(#reading-share-card-content-clip)">
    ${content.map((line, index) => `<text x="52" y="${374 + index * 36}" fill="#34302a" font-size="22">${escapeXml(line)}</text>`).join("\n    ")}
  </g>
  <text x="52" y="706" fill="#9b9488" font-size="18">${escapeXml(tags || "Lume Reading")}</text>
  <line x1="52" y1="780" x2="668" y2="780" stroke="#e4d8c5"/>
  <text x="52" y="830" fill="#9b7a46" font-size="22" font-weight="700">Lume Reading</text>
  <text x="52" y="866" fill="#9b9488" font-size="16">以上内容均由 AI 生成，纯属虚构，请注意甄别</text>
</svg>
`;
}

function toSvgImageHref(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (/^(https?:|data:|file:|blob:)/i.test(trimmed)) return trimmed;
  if (trimmed.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(trimmed)) {
    return pathToFileURL(trimmed).toString();
  }
  return trimmed;
}

function wrapText(value: string, lineLength: number, maxLines: number): string[] {
  const normalized = value.replace(/\s+/g, " ").trim();
  const lines: string[] = [];
  for (let index = 0; index < normalized.length && lines.length < maxLines; index += lineLength) {
    lines.push(normalized.slice(index, index + lineLength));
  }
  if (normalized.length > lineLength * maxLines && lines.length > 0) {
    lines[lines.length - 1] = `${lines[lines.length - 1]!.slice(0, Math.max(0, lineLength - 1))}…`;
  }
  return lines.length ? lines : ["Lume 在这本书旁边停了一会儿。"];
}

function bookInitial(value: string): string {
  return Array.from(value.trim())[0] ?? "书";
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
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
