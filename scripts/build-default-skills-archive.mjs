import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_DIR = resolve(REPO_ROOT, "apps", "sidecar", "default-skills");
const OUTFILE = resolve(REPO_ROOT, "apps", "desktop", "resources", "default-skills.tar");
const BLOCK_SIZE = 512;

function writeString(buffer, offset, length, value) {
  buffer.write(value.slice(0, length), offset, length, "utf8");
}

function writeOctal(buffer, offset, length, value) {
  const text = value.toString(8).padStart(length - 1, "0");
  buffer.write(`${text}\0`, offset, length, "ascii");
}

function createHeader(name, stats, typeflag) {
  const header = Buffer.alloc(BLOCK_SIZE, 0);
  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, typeflag === "5" ? 0o755 : 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, typeflag === "5" ? 0 : stats.size);
  writeOctal(header, 136, 12, Math.floor(stats.mtimeMs / 1000));
  header.fill(0x20, 148, 156);
  writeString(header, 156, 1, typeflag);
  writeString(header, 257, 6, "ustar");
  writeString(header, 263, 2, "00");

  let checksum = 0;
  for (const byte of header) {
    checksum += byte;
  }
  writeOctal(header, 148, 8, checksum);
  return header;
}

function padContent(content) {
  const remainder = content.length % BLOCK_SIZE;
  if (remainder === 0) {
    return content;
  }
  return Buffer.concat([content, Buffer.alloc(BLOCK_SIZE - remainder)]);
}

function collectEntries(dir) {
  const entries = [];
  for (const name of readdirSync(dir).sort()) {
    const fullPath = join(dir, name);
    const stats = statSync(fullPath);
    const archiveName = relative(SOURCE_DIR, fullPath).replaceAll("\\", "/");
    if (stats.isDirectory()) {
      entries.push({ archiveName: `${archiveName}/`, fullPath, stats, typeflag: "5" });
      entries.push(...collectEntries(fullPath));
    } else if (stats.isFile()) {
      entries.push({ archiveName, fullPath, stats, typeflag: "0" });
    }
  }
  return entries;
}

const chunks = [];
for (const entry of collectEntries(SOURCE_DIR)) {
  chunks.push(createHeader(entry.archiveName, entry.stats, entry.typeflag));
  if (entry.typeflag === "0") {
    chunks.push(padContent(readFileSync(entry.fullPath)));
  }
}
chunks.push(Buffer.alloc(BLOCK_SIZE * 2));

mkdirSync(dirname(OUTFILE), { recursive: true });
writeFileSync(OUTFILE, Buffer.concat(chunks));
console.error(`[default-skills-archive] wrote ${OUTFILE}`);
