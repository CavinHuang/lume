import type { ReadingNote } from "@lume/shared";

type ReadingNoteFrontmatter = Omit<ReadingNote, "body">;

export function serializeReadingNoteMarkdown(note: ReadingNote): string {
  const { body, ...frontmatter } = note;
  return `---\n${JSON.stringify(frontmatter, null, 2)}\n---\n\n${body.trimEnd()}\n`;
}

export function parseReadingNoteMarkdown(markdown: string): ReadingNote {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    throw new Error("读书笔记缺少 frontmatter");
  }
  const frontmatter = JSON.parse(match[1] ?? "{}") as ReadingNoteFrontmatter;
  const body = (match[2] ?? "").replace(/^\n/, "").trimEnd();
  return {
    ...frontmatter,
    body
  };
}
