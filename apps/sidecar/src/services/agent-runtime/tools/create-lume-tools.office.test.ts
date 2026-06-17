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
  const { execSync } = require("child_process");
  const { join } = require("path");
  const { mkdtempSync, writeFileSync } = require("fs");
  const { tmpdir } = require("os");

  const dir = mkdtempSync(join(tmpdir(), "lume-ooxml-"));
  for (const [name, content] of Object.entries(entries)) {
    writeFileSync(join(dir, name), content, "utf-8");
  }
  const out = join(tmpdir(), `lume-ooxml-${Date.now()}.zip`);
  execSync(`zip -r -q ${JSON.stringify(out)} .`, { cwd: dir });
  return require("fs").readFileSync(out);
}
