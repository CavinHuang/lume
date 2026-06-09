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
    writeFileSync(join(tempDir, "minimal.docx"), buildZip({
      "[Content_Types].xml": "<Types/>",
      "_rels/.rels": "<Relationships/>",
      "word/document.xml": "<w:document/>"
    }));

    const tool = resolveTool(createTools(), "office_validate");
    const result = await callTool(tool, { path: "minimal.docx", maxEntries: 5 }, tempDir);

    expect(result).toMatchObject({
      ok: true,
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
    writeFileSync(join(tempDir, "broken.pptx"), buildZip({
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
    writeFileSync(join(tempDir, "minimal.docx"), buildZip({
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
    writeFileSync(join(tempDir, "unsafe.docx"), buildZip({
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
      ok: true,
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

function buildZip(entries: Record<string, string>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const [name, content] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name);
    const data = Buffer.from(content);
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    nameBytes.copy(local, 30);
    localParts.push(local, data);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46);
    centralParts.push(central);

    offset += local.length + data.length;
  }

  const centralOffset = offset;
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(centralParts.length, 8);
  end.writeUInt16LE(centralParts.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, end]);
}
