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
  /** true = 窗口凑满且确认其后仍有内容；totalLines 只是已观察行数的下界，不是文件总行数。
   *  false = 精确读毕（含「凑满后确认 EOF」的全覆盖窗口），totalLines 可信。 */
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
  // 文件是否结束于行终止符；EOF 收尾时定案（尾行无终止符则置 false）。
  let endsAtTerminator = false;

  const consumeLine = (line: string): void => {
    if (totalLines >= offset && selectedLines.length < limit) {
      selectedLines.push(line);
    }
    totalLines += 1;
  };

  // 行终止口径与 decodeTextFile 的 normalizeLineEndings 一致：\r\n 与孤立 \r
  // 都算终止符。只剥 CRLF 尾 \r 的旧口径会让 CR-only 文件在 range 视图里
  // 变成"整文件一行且内嵌 \r"，而 Edit 侧解码归一成多行——两视图永不相等，
  // 强制先读后 Edit 必撞 stale_read 死循环（#569 回归审查实证）。
  const consumeCompleteLines = (): void => {
    // 缓冲尾部悬挂的 \r 先扣下：它可能与下一块开头的 \n 组成 \r\n。
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

    // The requested window is complete; avoid streaming a huge file to EOF just
    // to satisfy a small offset/limit (#314). But an immediate "truncated" also
    // mislabels the common "limit === totalLines" case, which would leave large
    // files with no read that ever unlocks Write/Edit (#649 review P1-5).
    // Compromise: keep scanning for at most a few extra chunks — a new line
    // confirms more content (truncated), natural EOF confirms exact full coverage.
    if (limit > 0 && selectedLines.length >= limit) {
      // Lines beyond the window may already have been counted within the same
      // chunk (the fill check runs after the whole chunk is consumed).
      const observedAtFill = totalLines;
      let sawMoreLines = observedAtFill - offset > limit;
      let gaveUpScanning = false;
      let extraChunks = 0;
      for await (const extra of stream) {
        if (++extraChunks > 8) { gaveUpScanning = true; break; }
        throwIfAborted(signal, stream);
        const extraText = String(extra);
        if (!extraText) continue;
        buffer += extraText;
        consumeCompleteLines();
        if (totalLines > observedAtFill) { sawMoreLines = true; break; }
      }
      // #649 round3:EOF 时 buffer 仍挂着未换行的尾巴行——它是窗口外的下一行
      // (收尾 flush 会计入 totalLines 却进不了 selected),并非精确全文。
      // (buffer 为悬挂 \r 的罕见形态会被保守误判 truncated,方向安全)
      if (!sawMoreLines && !gaveUpScanning && buffer.length > 0) sawMoreLines = true;
      truncated = sawMoreLines || gaveUpScanning;
      stream.destroy();
      break;
    }
  }

  throwIfAborted(signal, stream)

  // EOF：悬挂的 \r 不再有后续 \n，按孤立 \r 终止符收尾。
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

  // 文件以换行结尾 ⟺ 未提前停读且最后一行以终止符收束。
  // 结果必须忠实保留行尾换行，否则 Read 缓存的全视图与 Edit/Write 侧
  // decodeTextFile 的磁盘原文差一个 "\n"，全视图内容比对会误报 stale（#569）。
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
