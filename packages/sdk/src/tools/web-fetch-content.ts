import { createRequire } from "node:module";
import { unzipSync } from "fflate";
import { createTurndown, extractArticleMarkdown } from "./html-to-markdown.js";

const require = createRequire(import.meta.url);
const MAX_ARCHIVE_ENTRIES = 100;
const MAX_ARCHIVE_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_TEXT_ENTRY_BYTES = 512 * 1024;

export interface StructuredBinaryResult {
  markdown: string;
  title?: string;
  kind: string;
}

function kindFor(contentType: string, url: string): string | null {
  const type = contentType.toLowerCase();
  const path = (() => { try { return new URL(url).pathname.toLowerCase(); } catch { return ""; } })();
  if (type.includes("pdf") || path.endsWith(".pdf")) return "pdf";
  if (type.includes("wordprocessingml") || path.endsWith(".docx")) return "docx";
  if (type.includes("epub") || path.endsWith(".epub")) return "epub";
  if (type.includes("spreadsheetml") || path.endsWith(".xlsx")) return "xlsx";
  if (type.includes("presentationml") || path.endsWith(".pptx")) return "pptx";
  if (type.includes("zip") || path.endsWith(".zip")) return "zip";
  if (type.includes("tar") || path.endsWith(".tar") || path.endsWith(".tgz") || path.endsWith(".tar.gz")) return "tar";
  if (type.includes("sqlite") || type.includes("x-sqlite") || /\.(sqlite|sqlite3|db)$/.test(path)) return "sqlite";
  return null;
}

function textFromHtml(html: string, url: string): string {
  const article = extractArticleMarkdown(html, url);
  return article?.content || createTurndown().turndown(html).trim();
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function archiveText(name: string, bytes: Uint8Array): string | null {
  if (bytes.byteLength > MAX_TEXT_ENTRY_BYTES) return null;
  if (!/\.(md|markdown|txt|json|csv|xml|html?|ya?ml|toml|js|ts|py|rs|go|java|css)$/i.test(name)) return null;
  const text = decode(bytes).replace(/\0/g, "").trim();
  return text.length > 0 ? text.slice(0, MAX_TEXT_ENTRY_BYTES) : null;
}

function zipEntries(bytes: Uint8Array): Record<string, Uint8Array> {
  // The filter runs before each entry is decompressed and reports the
  // uncompressed size from the central directory, so entries beyond the
  // entry/byte budget are never inflated into memory (zip bombs abort).
  let entries = 0;
  let totalBytes = 0;
  return unzipSync(bytes, {
    filter: (file) => {
      if (entries >= MAX_ARCHIVE_ENTRIES) return false;
      if (totalBytes + file.originalSize > MAX_ARCHIVE_UNCOMPRESSED_BYTES) {
        throw new Error(`zip archive uncompressed size exceeds ${MAX_ARCHIVE_UNCOMPRESSED_BYTES} bytes`);
      }
      entries += 1;
      totalBytes += file.originalSize;
      return true;
    },
  }) as Record<string, Uint8Array>;
}

function renderZip(bytes: Uint8Array, url: string, kind: string): StructuredBinaryResult {
  const entries = zipEntries(bytes);
  const names = Object.keys(entries).slice(0, MAX_ARCHIVE_ENTRIES);
  if (kind === "epub" || names.some(name => /\.(x?html?|xhtml)$/i.test(name) && /content|text|chapter|book/i.test(name))) {
    const parts = names
      .filter(name => /\.(x?html?|xhtml)$/i.test(name))
      .map(name => textFromHtml(decode(entries[name]!), url))
      .filter(Boolean);
    if (parts.length > 0) return { kind, markdown: parts.join("\n\n"), title: "EPUB" };
  }
  if (kind === "xlsx") {
    const values = names.filter(name => /xl\/(sharedStrings|worksheets)\/.*\.xml$/i.test(name))
      .map(name => decode(entries[name]!).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim())
      .filter(Boolean);
    return { kind, markdown: `# XLSX\n\n${values.join("\n\n") || names.join("\n")}` };
  }
  if (kind === "pptx") {
    const slides = names.filter(name => /ppt\/slides\/slide\d+\.xml$/i.test(name))
      .map(name => decode(entries[name]!).match(/<a:t[^>]*>([\s\S]*?)<\/a:t>/gi)?.map(value => value.replace(/<[^>]+>/g, "")).join(" ") || "")
      .filter(Boolean);
    return { kind, markdown: `# PPTX\n\n${slides.join("\n\n") || names.join("\n")}` };
  }
  const readable = names.map(name => {
    const text = archiveText(name, entries[name]!);
    return text ? `## ${name}\n\n${text}` : null;
  }).filter((value): value is string => Boolean(value));
  return { kind, markdown: `# Archive\n\n## Files\n\n${names.map(name => `- ${name}`).join("\n")}${readable.length ? `\n\n${readable.join("\n\n")}` : ""}` };
}

function readTar(bytes: Uint8Array): Array<{ name: string; data: Uint8Array }> {
  const entries: Array<{ name: string; data: Uint8Array }> = [];
  for (let offset = 0; offset + 512 <= bytes.length && entries.length < MAX_ARCHIVE_ENTRIES;) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const name = decode(header.subarray(0, 100)).replace(/\0.*$/, "").trim();
    const sizeText = decode(header.subarray(124, 136)).replace(/\0.*$/, "").trim();
    const size = Number.parseInt(sizeText || "0", 8);
    if (!name || !Number.isFinite(size) || size < 0 || offset + 512 + size > bytes.length) break;
    entries.push({ name, data: bytes.slice(offset + 512, offset + 512 + size) });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

async function renderSqlite(bytes: Uint8Array): Promise<StructuredBinaryResult> {
  // @ts-ignore sql.js does not publish TypeScript declarations.
  const module = await import("sql.js") as unknown as { default?: (config?: Record<string, unknown>) => Promise<any> };
  const init = module.default ?? (module as unknown as ((config?: Record<string, unknown>) => Promise<any>));
  const wasmPath = require.resolve("sql.js/dist/sql-wasm.wasm");
  const SQL = await init({ locateFile: () => wasmPath });
  const db = new SQL.Database(bytes);
  try {
    const tables = db.exec("SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name");
    const lines = ["# SQLite database", ""];
    for (const table of tables[0]?.values ?? []) {
      const name = String(table[0]);
      const schema = String(table[1] ?? "");
      lines.push(`## ${name}`, "", "```sql", schema, "```", "");
      const safeName = name.replace(/"/g, '""');
      const sample = db.exec(`SELECT * FROM "${safeName}" LIMIT 5`)[0];
      if (sample) {
        lines.push(`| ${sample.columns.join(" | ")} |`, `| ${sample.columns.map(() => "---").join(" | ")} |`);
        for (const row of sample.values) lines.push(`| ${row.map((value: unknown) => String(value ?? "").replace(/\|/g, "\\|")).join(" | ")} |`);
        lines.push("");
      }
    }
    return { kind: "sqlite", markdown: lines.join("\n").trim() };
  } finally {
    db.close();
  }
}

export async function renderStructuredBinary(bytes: Uint8Array, contentType: string, url: string): Promise<StructuredBinaryResult | null> {
  const kind = kindFor(contentType, url);
  if (!kind) return null;
  if (kind === "pdf") {
    const mupdf = await import("mupdf");
    const document = mupdf.Document.openDocument(Buffer.from(bytes), "application/pdf");
    try {
      const pages: string[] = [];
      for (let index = 0; index < Math.min(document.countPages(), 100); index++) {
        const page = document.loadPage(index);
        const text = page.toStructuredText().asText().trim();
        page.destroy();
        pages.push(text);
      }
      return { kind, title: document.getMetaData("info:Title") || undefined, markdown: pages.filter(Boolean).join("\n\n") };
    } finally {
      // mupdf documents/pages live in a WASM heap; without destroy every fetch
      // of a PDF permanently grows sidecar memory (#245)
      document.destroy();
    }
  }
  if (kind === "docx") {
    const mammoth = (await import("mammoth")).default;
    const result = await mammoth.convertToHtml({ buffer: Buffer.from(bytes) });
    return { kind, markdown: textFromHtml(result.value, url) };
  }
  if (kind === "sqlite") return renderSqlite(bytes);
  if (kind === "zip" || kind === "epub" || kind === "xlsx" || kind === "pptx") return renderZip(bytes, url, kind);
  if (kind === "tar") {
    const entries = readTar(bytes);
    const readable = entries.map(entry => {
      const text = archiveText(entry.name, entry.data);
      return text ? `## ${entry.name}\n\n${text}` : `- ${entry.name}`;
    });
    return { kind, markdown: `# TAR archive\n\n${readable.join("\n\n")}` };
  }
  return null;
}

export function contentKind(contentType: string, url: string): string | null {
  return kindFor(contentType, url);
}
