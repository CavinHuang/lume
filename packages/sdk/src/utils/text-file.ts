import { createReadStream, promises as fs } from "node:fs";

export type TextFileEncoding = Extract<BufferEncoding, "utf8" | "utf16le">;
export type TextFileLineEnding = "CRLF" | "LF" | "CR";

export interface DecodedTextFile {
  content: string;
  encoding: TextFileEncoding;
  lineEnding: TextFileLineEnding;
  bom: boolean;
}

export interface TextFileRange {
  content: string;
  totalLines: number;
}

export async function readTextFile(filePath: string): Promise<DecodedTextFile> {
  return decodeTextFile(await fs.readFile(filePath));
}

export async function readTextFileRange(
  filePath: string,
  offset: number,
  limit: number,
  signal?: AbortSignal,
): Promise<TextFileRange> {
  const encoding = await detectTextFileEncoding(filePath);
  const stream = createReadStream(filePath, { encoding });
  const selectedLines: string[] = [];
  let buffer = "";
  let totalLines = 0;
  let endedWithNewline = false;

  const consumeLine = (line: string): void => {
    const normalized = line.replace(/\r$/, "");
    if (totalLines >= offset && selectedLines.length < limit) {
      selectedLines.push(normalized);
    }
    totalLines += 1;
  };

  for await (const chunk of stream) {
    throwIfAborted(signal, stream)
    const text = String(chunk);
    if (!text) continue;
    buffer += text;
    endedWithNewline = false;

    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      consumeLine(buffer.slice(0, newlineIndex));
      buffer = buffer.slice(newlineIndex + 1);
      endedWithNewline = true;
      newlineIndex = buffer.indexOf("\n");
    }
  }

  throwIfAborted(signal, stream)

  if (buffer.length > 0 || endedWithNewline) {
    consumeLine(buffer);
  }

  if (selectedLines.length > 0 && selectedLines[0]?.startsWith("\uFEFF")) {
    selectedLines[0] = selectedLines[0].slice(1);
  }

  return { content: selectedLines.join("\n"), totalLines };
}

function throwIfAborted(signal: AbortSignal | undefined, stream?: NodeJS.ReadableStream): void {
  if (!signal?.aborted) return
  ;(stream as { destroy?: () => void } | undefined)?.destroy?.()
  const error = new Error("Operation aborted")
  error.name = "AbortError"
  throw error
}

export function decodeTextFile(bytes: Uint8Array): DecodedTextFile {
  const input = Buffer.from(bytes);
  let encoding: TextFileEncoding = "utf8";
  let bom = false;
  let body = input;

  if (input.length >= 2 && input[0] === 0xff && input[1] === 0xfe) {
    encoding = "utf16le";
    bom = true;
    body = input.subarray(2);
  } else if (input.length >= 3 && input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf) {
    bom = true;
    body = input.subarray(3);
  }

  const raw = body.toString(encoding);
  const lineEnding = detectLineEnding(raw);
  return {
    content: normalizeLineEndings(raw),
    encoding,
    lineEnding,
    bom,
  };
}

export function encodeTextFile(content: string, file: DecodedTextFile): Buffer {
  const restored = restoreLineEndings(content, file.lineEnding);
  const body = Buffer.from(restored, file.encoding);
  if (!file.bom) return body;
  if (file.encoding === "utf16le") return Buffer.concat([Buffer.from([0xff, 0xfe]), body]);
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]);
}

export function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function restoreLineEndings(content: string, lineEnding: TextFileLineEnding): string {
  if (lineEnding === "CRLF") return content.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
  if (lineEnding === "CR") return content.replace(/\r\n/g, "\n").replace(/\n/g, "\r");
  return normalizeLineEndings(content);
}

async function detectTextFileEncoding(filePath: string): Promise<TextFileEncoding> {
  const handle = await fs.open(filePath, "r");
  try {
    const header = Buffer.alloc(3);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead >= 2 && header[0] === 0xff && header[1] === 0xfe) return "utf16le";
    return "utf8";
  } finally {
    await handle.close();
  }
}

function detectLineEnding(content: string): TextFileLineEnding {
  if (content.includes("\r\n")) return "CRLF";
  if (content.includes("\r")) return "CR";
  return "LF";
}
