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
  /** true = 窗口凑满提前停读；totalLines 只是已观察行数的下界，不是文件总行数。 */
  truncated: boolean;
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
  let truncated = false;

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

    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      consumeLine(buffer.slice(0, newlineIndex));
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");
    }

    // The requested window is complete; stop reading so huge files are not
    // streamed to EOF just to satisfy a small offset/limit. totalLines then
    // only lower-bounds the file; truncated tells callers it is not exact (#314).
    if (limit > 0 && selectedLines.length >= limit) {
      truncated = true;
      stream.destroy();
      break;
    }
  }

  throwIfAborted(signal, stream)

  // \u6587\u4EF6\u4EE5\u6362\u884C\u7ED3\u5C3E \u27FA \u672A\u63D0\u524D\u505C\u8BFB\u3001\u8BFB\u5230 EOF \u65F6\u7F13\u51B2\u5DF2\u7A7A\u4E14\u81F3\u5C11\u6709\u4E00\u884C\u3002
  // \u7ED3\u679C\u5FC5\u987B\u5FE0\u5B9E\u4FDD\u7559\u884C\u5C3E\u6362\u884C\uFF0C\u5426\u5219 Read \u7F13\u5B58\u7684\u5168\u89C6\u56FE\u4E0E Edit/Write \u4FA7
  // decodeTextFile \u7684\u78C1\u76D8\u539F\u6587\u5DEE\u4E00\u4E2A "\n"\uFF0C\u5168\u89C6\u56FE\u5185\u5BB9\u6BD4\u5BF9\u4F1A\u8BEF\u62A5 stale\uFF08#569\uFF09\u3002
  const endsWithNewline = !truncated && buffer.length === 0 && totalLines > 0;

  if (buffer.length > 0) {
    consumeLine(buffer);
  }

  if (selectedLines.length > 0 && selectedLines[0]?.startsWith("\uFEFF")) {
    selectedLines[0] = selectedLines[0].slice(1);
  }

  const content = selectedLines.join("\n");
  return {
    content: endsWithNewline && selectedLines.length > 0 ? `${content}\n` : content,
    totalLines,
    truncated,
  };
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
