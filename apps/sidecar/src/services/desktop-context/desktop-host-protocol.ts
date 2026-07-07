const DEFAULT_MAX_FRAME_BYTES = 16 * 1024 * 1024;

export type DesktopHostMessage = Record<string, unknown>;

export function encodeDesktopHostFrame(message: DesktopHostMessage): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const frame = Buffer.allocUnsafe(body.length + 4);
  frame.writeUInt32LE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

export class DesktopHostFrameDecoder {
  #buffer = Buffer.alloc(0);

  constructor(private readonly maxFrameBytes = DEFAULT_MAX_FRAME_BYTES) {}

  push(chunk: Buffer): DesktopHostMessage[] {
    if (chunk.length > 0) {
      this.#buffer = this.#buffer.length === 0
        ? Buffer.from(chunk)
        : Buffer.concat([this.#buffer, chunk]);
    }

    const messages: DesktopHostMessage[] = [];
    while (this.#buffer.length >= 4) {
      const bodyLength = this.#buffer.readUInt32LE(0);
      if (bodyLength > this.maxFrameBytes) {
        this.#buffer = Buffer.alloc(0);
        throw new Error(`desktop host frame exceeds ${this.maxFrameBytes} bytes`);
      }
      const frameLength = bodyLength + 4;
      if (this.#buffer.length < frameLength) break;
      const body = this.#buffer.subarray(4, frameLength).toString("utf8");
      this.#buffer = this.#buffer.subarray(frameLength);
      const parsed = JSON.parse(body);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("desktop host frame must contain a JSON object");
      }
      messages.push(parsed as DesktopHostMessage);
    }
    return messages;
  }
}
