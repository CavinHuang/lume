import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@lume/agent-sdk";
import { createLumeRuntimeTools } from "./create-lume-tools";

function createTools(): ToolDefinition[] {
  return createLumeRuntimeTools({
    threadId: "thread-1",
    includeCitations: false,
    emitAskUserQuestion: () => {},
    emitToolPermissionRequest: () => {}
  }).customTools;
}

function resolveTool(tools: ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find((item) => item.name === name);
  if (!tool) {
    throw new Error(`工具不存在: ${name}`);
  }
  return tool;
}

async function callTool(tool: ToolDefinition, input: Record<string, unknown>, cwd: string) {
  const result = await tool.call(input, { cwd, abortSignal: new AbortController().signal });
  const maybeData = result as { data?: unknown; content?: unknown };
  if (maybeData.data !== undefined) return maybeData.data as Record<string, unknown>;
  return JSON.parse(String(maybeData.content)) as Record<string, unknown>;
}

describe("createLumeRuntimeTools office_validate", () => {
  let tempDir = "";

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "lume-office-tool-"));
  });

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = "";
    }
  });

  test("exposes a read-only Office validator for basic OOXML packages", async () => {
    writeFileSync(join(tempDir, "minimal.docx"), buildValidZip({
      "[Content_Types].xml": "<Types/>",
      "_rels/.rels": "<Relationships/>",
      "word/document.xml": "<w:document/>"
    }));

    const tool = resolveTool(createTools(), "office_validate");
    const result = await callTool(tool, { path: "minimal.docx", maxEntries: 5 }, tempDir);

    expect(result).toMatchObject({
      ok: false,
      kind: "docx",
      entryCount: 3,
      missingRequiredEntries: []
    });
    expect(result.entries).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "word/document.xml"
    ]);
  });

  test("reports missing OOXML required parts without writing files", async () => {
    writeFileSync(join(tempDir, "broken.pptx"), buildValidZip({
      "[Content_Types].xml": "<Types/>",
      "_rels/.rels": "<Relationships/>"
    }));

    const tool = resolveTool(createTools(), "office_validate");
    const result = await callTool(tool, { path: "broken.pptx" }, tempDir);

    expect(result).toMatchObject({
      ok: false,
      kind: "pptx",
      missingRequiredEntries: ["ppt/presentation.xml"]
    });
  });
});

describe("createLumeRuntimeTools office_unpack", () => {
  let tempDir = "";

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "lume-office-unpack-tool-"));
  });

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = "";
    }
  });

  test("unpacks a basic OOXML package into a selected output directory", async () => {
    writeFileSync(join(tempDir, "minimal.docx"), buildValidZip({
      "[Content_Types].xml": "<Types/>",
      "_rels/.rels": "<Relationships/>",
      "word/document.xml": "<w:document/>"
    }));

    const tool = resolveTool(createTools(), "office_unpack");
    const result = await callTool(tool, {
      path: "minimal.docx",
      outputDir: "unpacked"
    }, tempDir);

    expect(result).toMatchObject({
      ok: true,
      kind: "docx",
      writtenCount: 3,
      skippedUnsafeEntries: []
    });
    expect(readFileSync(join(tempDir, "unpacked", "word", "document.xml"), "utf-8")).toBe("<w:document/>");
  });

  test("skips unsafe zip entry paths while unpacking", async () => {
    writeFileSync(join(tempDir, "unsafe.docx"), buildValidZip({
      "[Content_Types].xml": "<Types/>",
      "_rels/.rels": "<Relationships/>",
      "word/document.xml": "<w:document/>",
      "../evil.txt": "nope"
    }));

    const tool = resolveTool(createTools(), "office_unpack");
    const result = await callTool(tool, {
      path: "unsafe.docx",
      outputDir: "safe"
    }, tempDir);

    expect(result).toMatchObject({
      ok: true,
      skippedUnsafeEntries: ["../evil.txt"]
    });
    expect(existsSync(join(tempDir, "evil.txt"))).toBe(false);
    expect(readFileSync(join(tempDir, "safe", "word", "document.xml"), "utf-8")).toBe("<w:document/>");
  });
});

describe("createLumeRuntimeTools office_pack", () => {
  let tempDir = "";

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "lume-office-pack-tool-"));
  });

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = "";
    }
  });

  test("packs an unpacked OOXML directory into a valid Office package", async () => {
    mkdirSync(join(tempDir, "unpacked", "_rels"), { recursive: true });
    mkdirSync(join(tempDir, "unpacked", "word"), { recursive: true });
    writeFileSync(join(tempDir, "unpacked", "[Content_Types].xml"), "<Types/>");
    writeFileSync(join(tempDir, "unpacked", "_rels", ".rels"), "<Relationships/>");
    writeFileSync(join(tempDir, "unpacked", "word", "document.xml"), "<w:document/>");

    const packTool = resolveTool(createTools(), "office_pack");
    const packResult = await callTool(packTool, {
      inputDir: "unpacked",
      outputPath: "rebuilt.docx"
    }, tempDir);

    expect(packResult).toMatchObject({
      ok: true,
      kind: "docx",
      entryCount: 3,
      outputPath: join(tempDir, "rebuilt.docx")
    });
    expect(packResult.entries).toEqual(expect.arrayContaining([
      "[Content_Types].xml",
      "_rels/.rels",
      "word/document.xml"
    ]));

    const validateTool = resolveTool(createTools(), "office_validate");
    const validateResult = await callTool(validateTool, { path: "rebuilt.docx" }, tempDir);
    expect(validateResult).toMatchObject({
      ok: false,
      kind: "docx",
      missingRequiredEntries: []
    });
  });

  test("rejects output paths inside the input directory", async () => {
    mkdirSync(join(tempDir, "unpacked"), { recursive: true });
    writeFileSync(join(tempDir, "unpacked", "[Content_Types].xml"), "<Types/>");

    const tool = resolveTool(createTools(), "office_pack");
    const result = await tool.call({
      inputDir: "unpacked",
      outputPath: "unpacked/rebuilt.docx"
    }, { cwd: tempDir, abortSignal: new AbortController().signal });

    expect(String((result as { content?: unknown }).content)).toContain(
      "office_pack outputPath must be outside inputDir"
    );
  });
});

function crc32(buf: Buffer): number {
  let crc = -1;
  const table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        if (c & 1) c = 0xedb88320 ^ (c >>> 1);
        else c = c >>> 1;
      }
      t[n] = c;
    }
    return t;
  })();
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

function buildValidZip(entries: Record<string, string>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name, "utf-8");
    const data = Buffer.from(content, "utf-8");
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    localParts.push(local, nameBytes, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, nameBytes);
    localOffset += local.length + nameBytes.length + data.length;
  }

  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  const entryCount = Object.keys(entries).length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entryCount, 8);
  end.writeUInt16LE(entryCount, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, ...centralParts, end]);
}
