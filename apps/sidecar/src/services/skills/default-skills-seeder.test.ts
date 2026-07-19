import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractDefaultSkillsArchive, safeTargetPath } from "./default-skills-seeder";

const BLOCK_SIZE = 512;

describe("default-skills-seeder", () => {
  let tempDir = "";

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "lume-default-skills-seeder-"));
  });

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = "";
    }
  });

  test("extractDefaultSkillsArchive extracts missing skills from tar", () => {
    const archivePath = join(tempDir, "default-skills.tar");
    const targetDir = join(tempDir, "default-skills");
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(archivePath, createTar([
      { name: "alpha/", type: "5" },
      { name: "alpha/SKILL.md", content: "Alpha skill" },
      { name: "beta/", type: "5" },
      { name: "beta/SKILL.md", content: "Beta skill" }
    ]));

    extractDefaultSkillsArchive(archivePath, targetDir);

    expect(readFileSync(join(targetDir, "alpha", "SKILL.md"), "utf-8")).toBe("Alpha skill");
    expect(readFileSync(join(targetDir, "beta", "SKILL.md"), "utf-8")).toBe("Beta skill");
  });

  test("extractDefaultSkillsArchive preserves existing skill directories", () => {
    const archivePath = join(tempDir, "default-skills.tar");
    const targetDir = join(tempDir, "default-skills");
    mkdirSync(join(targetDir, "alpha"), { recursive: true });
    writeFileSync(join(targetDir, "alpha", "SKILL.md"), "User edited");
    writeFileSync(archivePath, createTar([
      { name: "alpha/", type: "5" },
      { name: "alpha/SKILL.md", content: "Bundled" }
    ]));

    extractDefaultSkillsArchive(archivePath, targetDir);

    expect(readFileSync(join(targetDir, "alpha", "SKILL.md"), "utf-8")).toBe("User edited");
  });

  test("extractDefaultSkillsArchive upgrades an older bundled skill by version", () => {
    const archivePath = join(tempDir, "default-skills.tar");
    const targetDir = join(tempDir, "default-skills");
    mkdirSync(join(targetDir, "alpha"), { recursive: true });
    writeFileSync(join(targetDir, "alpha", "SKILL.md"), skillContent("2.0", "Old instructions"));
    writeFileSync(archivePath, createTar([
      { name: "alpha/", type: "5" },
      { name: "alpha/SKILL.md", content: skillContent("3.0", "New instructions") }
    ]));

    extractDefaultSkillsArchive(archivePath, targetDir);

    expect(readFileSync(join(targetDir, "alpha", "SKILL.md"), "utf-8")).toContain("New instructions");
  });

  test("extractDefaultSkillsArchive preserves an equal or newer installed version", () => {
    const archivePath = join(tempDir, "default-skills.tar");
    const targetDir = join(tempDir, "default-skills");
    mkdirSync(join(targetDir, "alpha"), { recursive: true });
    writeFileSync(join(targetDir, "alpha", "SKILL.md"), skillContent("3.1", "Keep installed"));
    writeFileSync(archivePath, createTar([
      { name: "alpha/", type: "5" },
      { name: "alpha/SKILL.md", content: skillContent("3.0", "Bundled instructions") }
    ]));

    extractDefaultSkillsArchive(archivePath, targetDir);

    expect(readFileSync(join(targetDir, "alpha", "SKILL.md"), "utf-8")).toContain("Keep installed");
  });

  test("safeTargetPath rejects tar path traversal entries", () => {
    expect(safeTargetPath(tempDir, "../outside.txt")).toBeNull();
    expect(safeTargetPath(tempDir, "alpha/../../outside.txt")).toBeNull();
    expect(safeTargetPath(tempDir, "alpha/SKILL.md")).toBe(join(tempDir, "alpha", "SKILL.md"));
  });
});

function skillContent(version: string, body: string): string {
  return `---\nname: "Alpha"\nversion: "${version}"\n---\n\n${body}`;
}

function createTar(entries: Array<{ name: string; content?: string; type?: string }>): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const content = Buffer.from(entry.content ?? "");
    chunks.push(createHeader(entry.name, content.length, entry.type ?? "0"));
    if ((entry.type ?? "0") !== "5") {
      chunks.push(padContent(content));
    }
  }
  chunks.push(Buffer.alloc(BLOCK_SIZE * 2));
  return Buffer.concat(chunks);
}

function createHeader(name: string, size: number, typeflag: string): Buffer {
  const header = Buffer.alloc(BLOCK_SIZE, 0);
  header.write(name, 0, 100, "utf8");
  writeOctal(header, 100, 8, typeflag === "5" ? 0o755 : 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, typeflag === "5" ? 0 : size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header.write(typeflag, 156, 1, "ascii");
  header.write("ustar", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");

  let checksum = 0;
  for (const byte of header) checksum += byte;
  writeOctal(header, 148, 8, checksum);
  return header;
}

function writeOctal(buffer: Buffer, offset: number, length: number, value: number): void {
  buffer.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length, "ascii");
}

function padContent(content: Buffer): Buffer {
  const remainder = content.length % BLOCK_SIZE;
  if (remainder === 0) return content;
  return Buffer.concat([content, Buffer.alloc(BLOCK_SIZE - remainder)]);
}
