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
  // \u6587\u4EF6\u662F\u5426\u7ED3\u675F\u4E8E\u884C\u7EC8\u6B62\u7B26\uFF1BEOF \u6536\u5C3E\u65F6\u5B9A\u6848\uFF08\u5C3E\u884C\u65E0\u7EC8\u6B62\u7B26\u5219\u7F6E false\uFF09\u3002
  let endsAtTerminator = false;

  const consumeLine = (line: string): void => {
    if (totalLines >= offset && selectedLines.length < limit) {
      selectedLines.push(line);
    }
    totalLines += 1;
  };

  // \u884C\u7EC8\u6B62\u53E3\u5F84\u4E0E decodeTextFile \u7684 normalizeLineEndings \u4E00\u81F4\uFF1A\r\n \u4E0E\u5B64\u7ACB \r
  // \u90FD\u7B97\u7EC8\u6B62\u7B26\u3002\u53EA\u5265 CRLF \u5C3E \r \u7684\u65E7\u53E3\u5F84\u4F1A\u8BA9 CR-only \u6587\u4EF6\u5728 range \u89C6\u56FE\u91CC
  // \u53D8\u6210"\u6574\u6587\u4EF6\u4E00\u884C\u4E14\u5185\u5D4C \r"\uFF0C\u800C Edit \u4FA7\u89E3\u7801\u5F52\u4E00\u6210\u591A\u884C\u2014\u2014\u4E24\u89C6\u56FE\u6C38\u4E0D\u76F8\u7B49\uFF0C
  // \u5F3A\u5236\u5148\u8BFB\u540E Edit \u5FC5\u649E stale_read \u6B7B\u5FAA\u73AF\uFF08#569 \u56DE\u5F52\u5BA1\u67E5\u5B9E\u8BC1\uFF09\u3002
  const consumeCompleteLines = (): void => {
    // \u7F13\u51B2\u5C3E\u90E8\u60AC\u6302\u7684 \r \u5148\u6263\u4E0B\uFF1A\u5B83\u53EF\u80FD\u4E0E\u4E0B\u4E00\u5757\u5F00\u5934\u7684 \n \u7EC4\u6210 \r\n\u3002
    const holdback = buffer.endsWith("\r") ? 1 : 0;
    const searchable = holdback ? buffer.slice(0, -1) : buffer;
    const terminator = /\r\n|\r|\n/g;
    let cursor = 0;
    for (let match = terminator.exec(searchable); match; match = terminator.exec(searchable)) {
      consumeLine(searchable.slice(cursor, match.index));
      cursor = match.index + match[0].length;
      endsAtTerminator = true;
    }
    buffer = searchable.slice(cursor) + (holdback ? "\r" : "");
  };

  for await (const chunk of stream) {
    throwIfAborted(signal, stream)
    const text = String(chunk);
    if (!text) continue;
    buffer += text;
    consumeCompleteLines();

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

  // EOF\uFF1A\u60AC\u6302\u7684 \r \u4E0D\u518D\u6709\u540E\u7EED \n\uFF0C\u6309\u5B64\u7ACB \r \u7EC8\u6B62\u7B26\u6536\u5C3E\u3002
  if (!truncated && buffer.endsWith("\r")) {
    consumeLine(buffer.slice(0, -1));
    buffer = "";
    endsAtTerminator = true;
  }
  if (buffer.length > 0) {
    consumeLine(buffer);
    buffer = "";
    endsAtTerminator = false;
  }

  // \u6587\u4EF6\u4EE5\u6362\u884C\u7ED3\u5C3E \u27FA \u672A\u63D0\u524D\u505C\u8BFB\u4E14\u6700\u540E\u4E00\u884C\u4EE5\u7EC8\u6B62\u7B26\u6536\u675F\u3002
  // \u7ED3\u679C\u5FC5\u987B\u5FE0\u5B9E\u4FDD\u7559\u884C\u5C3E\u6362\u884C\uFF0C\u5426\u5219 Read \u7F13\u5B58\u7684\u5168\u89C6\u56FE\u4E0E Edit/Write \u4FA7
  // decodeTextFile \u7684\u78C1\u76D8\u539F\u6587\u5DEE\u4E00\u4E2A "\n"\uFF0C\u5168\u89C6\u56FE\u5185\u5BB9\u6BD4\u5BF9\u4F1A\u8BEF\u62A5 stale\uFF08#569\uFF09\u3002
  const endsWithNewline = !truncated && endsAtTerminator && totalLines > 0;

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
