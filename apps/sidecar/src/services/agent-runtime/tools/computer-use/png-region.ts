import { deflateSync, inflateSync } from "node:zlib";

export interface PngRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function cropPng(bytes: Buffer, region: PngRegion): {
  bytes: Buffer;
  width: number;
  height: number;
} {
  if (!bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    throw new Error("screenshot is not a PNG");
  }
  const parsed = parsePng(bytes);
  const normalized = normalizeRegion(region);
  if (
    normalized.x + normalized.width > parsed.width
    || normalized.y + normalized.height > parsed.height
  ) {
    throw new Error("screenshot region is outside screenshot bounds");
  }
  const bytesPerPixel = parsed.colorType === 2 ? 3 : parsed.colorType === 6 ? 4 : 0;
  if (parsed.bitDepth !== 8 || bytesPerPixel === 0 || parsed.interlace !== 0) {
    throw new Error("unsupported screenshot PNG format");
  }
  const rows = unfilterRows(parsed.data, parsed.width, parsed.height, bytesPerPixel);
  const croppedStride = normalized.width * bytesPerPixel;
  const raw = Buffer.alloc((croppedStride + 1) * normalized.height);
  for (let row = 0; row < normalized.height; row += 1) {
    const destination = row * (croppedStride + 1);
    raw[destination] = 0;
    rows.copy(
      raw,
      destination + 1,
      ((normalized.y + row) * parsed.width + normalized.x) * bytesPerPixel,
      ((normalized.y + row) * parsed.width + normalized.x + normalized.width) * bytesPerPixel,
    );
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(normalized.width, 0);
  header.writeUInt32BE(normalized.height, 4);
  header[8] = parsed.bitDepth;
  header[9] = parsed.colorType;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  return {
    bytes: Buffer.concat([
      Buffer.from("89504e470d0a1a0a", "hex"),
      pngChunk("IHDR", header),
      pngChunk("IDAT", deflateSync(raw)),
      pngChunk("IEND", Buffer.alloc(0)),
    ]),
    width: normalized.width,
    height: normalized.height,
  };
}

function parsePng(bytes: Buffer): {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlace: number;
  data: Buffer;
} {
  let offset = 8;
  let header: Buffer | undefined;
  const data: Buffer[] = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > bytes.length) throw new Error("invalid screenshot PNG chunks");
    if (type === "IHDR") header = bytes.subarray(start, end);
    if (type === "IDAT") data.push(bytes.subarray(start, end));
    if (type === "IEND") break;
    offset = end + 4;
  }
  if (!header || header.length !== 13 || data.length === 0) {
    throw new Error("invalid screenshot PNG structure");
  }
  return {
    width: header.readUInt32BE(0),
    height: header.readUInt32BE(4),
    bitDepth: header[8]!,
    colorType: header[9]!,
    interlace: header[12]!,
    data: inflateSync(Buffer.concat(data)),
  };
}

function unfilterRows(data: Buffer, width: number, height: number, bpp: number): Buffer {
  const stride = width * bpp;
  if (data.length !== (stride + 1) * height) throw new Error("invalid screenshot PNG scanlines");
  const output = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = data[y * (stride + 1)]!;
    for (let x = 0; x < stride; x += 1) {
      const raw = data[y * (stride + 1) + x + 1]!;
      const left = x >= bpp ? output[y * stride + x - bpp]! : 0;
      const up = y > 0 ? output[(y - 1) * stride + x]! : 0;
      const upperLeft = y > 0 && x >= bpp ? output[(y - 1) * stride + x - bpp]! : 0;
      const value = filter === 0 ? raw
        : filter === 1 ? raw + left
          : filter === 2 ? raw + up
            : filter === 3 ? raw + Math.floor((left + up) / 2)
              : filter === 4 ? raw + paeth(left, up, upperLeft)
                : Number.NaN;
      if (!Number.isFinite(value)) throw new Error("unsupported screenshot PNG filter");
      output[y * stride + x] = value & 0xff;
    }
  }
  return output;
}

function normalizeRegion(region: PngRegion): PngRegion {
  const values = [region.x, region.y, region.width, region.height];
  if (!values.every((value) => Number.isInteger(value)) || region.x < 0 || region.y < 0 || region.width <= 0 || region.height <= 0) {
    throw new Error("screenshot region must contain positive integer dimensions");
  }
  return region;
}

function paeth(left: number, up: number, upperLeft: number): number {
  const prediction = left + up - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const upDistance = Math.abs(prediction - up);
  const upperLeftDistance = Math.abs(prediction - upperLeft);
  return leftDistance <= upDistance && leftDistance <= upperLeftDistance
    ? left
    : upDistance <= upperLeftDistance ? up : upperLeft;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), data.length + 8);
  return chunk;
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
