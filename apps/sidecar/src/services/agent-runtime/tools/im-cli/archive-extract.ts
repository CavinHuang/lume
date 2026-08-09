/**
 * 归档解压 + 完整性校验(移植自 wanta scripts/oo-cli.ts、ripgrep.ts)。
 * 全程仅用 node:crypto / node:zlib,不引入第三方解压库。
 * 覆盖 IM CLI 三渠道:tar.gz(ustar)+ zip(store/deflate)+ SRI/sha256 校验。
 */
import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";

/** 读取 tar header 中的定长字段(NUL 终止的 ASCII 子串)。 */
function readTarString(header: Buffer, start: number, len: number): string {
  const slice = header.subarray(start, start + len);
  const nul = slice.indexOf(0);
  return slice.toString("utf-8", 0, nul === -1 ? len : nul);
}

/**
 * 从解压后的 tar 字节里取出单个文件(npm tarball 为标准 ustar,路径短、无 GNU long-name)。
 * 逐 512 字节 header 遍历:按 size 跳过每条记录的数据块,命中目标普通文件(typeflag 0/\0)即返回内容;
 * pax/global 扩展头因名字不匹配被自然跳过。未找到返回 null;声明 size 越出缓冲区(截断/损坏)则抛错。
 */
export function extractFileFromTar(tar: Buffer, wantedPath: string): Buffer | null {
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    // 连续全零块标志归档结束。
    if (header.every((byte) => byte === 0)) break;
    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155); // ustar prefix(长路径才用到)
    const fullName = prefix ? `${prefix}/${name}` : name;
    const size = Number.parseInt(readTarString(header, 124, 12).trim() || "0", 8);
    const typeflag = String.fromCharCode(header[156] ?? 0);
    const dataStart = offset + 512;
    if ((typeflag === "0" || typeflag === "\0") && fullName === wantedPath) {
      if (dataStart + size > tar.length) {
        throw new Error(`truncated tar: ${wantedPath} declares ${size} bytes but archive ends early`);
      }
      return tar.subarray(dataStart, dataStart + size);
    }
    // 数据块按 512 向上取整对齐。
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return null;
}

function readUInt16(buffer: Buffer, offset: number): number {
  return buffer.readUInt16LE(offset);
}

function readUInt32(buffer: Buffer, offset: number): number {
  return buffer.readUInt32LE(offset);
}

/**
 * 从 zip 字节里取出单个文件(手写 EOCD + central directory 遍历)。
 * 支持 method 0(store,直接切片)与 method 8(deflate,inflateRawSync)。
 * 未找到返回 null;格式异常抛错。完整性由调用方对归档整体的 sha256/SRI 保证。
 */
export function extractFileFromZip(zip: Buffer, wantedPath: string): Buffer | null {
  const eocdSignature = 0x06054b50;
  let eocd = -1;
  for (let offset = zip.length - 22; offset >= 0 && offset >= zip.length - 65557; offset -= 1) {
    if (readUInt32(zip, offset) === eocdSignature) {
      eocd = offset;
      break;
    }
  }
  if (eocd === -1) throw new Error("invalid zip: end of central directory not found");

  const entryCount = readUInt16(zip, eocd + 10);
  let centralOffset = readUInt32(zip, eocd + 16);
  for (let index = 0; index < entryCount; index += 1) {
    if (readUInt32(zip, centralOffset) !== 0x02014b50) {
      throw new Error("invalid zip: central directory entry not found");
    }
    const method = readUInt16(zip, centralOffset + 10);
    const compressedSize = readUInt32(zip, centralOffset + 20);
    const fileNameLength = readUInt16(zip, centralOffset + 28);
    const extraLength = readUInt16(zip, centralOffset + 30);
    const commentLength = readUInt16(zip, centralOffset + 32);
    const localHeaderOffset = readUInt32(zip, centralOffset + 42);
    const fileName = zip.toString("utf-8", centralOffset + 46, centralOffset + 46 + fileNameLength);

    if (fileName === wantedPath) {
      if (readUInt32(zip, localHeaderOffset) !== 0x04034b50) {
        throw new Error(`invalid zip: local header not found for ${wantedPath}`);
      }
      const localNameLength = readUInt16(zip, localHeaderOffset + 26);
      const localExtraLength = readUInt16(zip, localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
      const data = zip.subarray(dataStart, dataStart + compressedSize);
      if (method === 0) return data;
      if (method === 8) return inflateRawSync(data);
      throw new Error(`unsupported zip compression method ${method} for ${wantedPath}`);
    }
    centralOffset += 46 + fileNameLength + extraLength + commentLength;
  }
  return null;
}

/** sha256 hex 校验,不匹配抛错。 */
export function verifySha256(data: Buffer, expected: string, source: string): void {
  const actual = createHash("sha256").update(data).digest("hex");
  if (actual !== expected) {
    throw new Error(`sha256 mismatch for ${source}: expected ${expected}, got ${actual}`);
  }
}

/**
 * 用 registry 提供的 SRI(integrity)校验 tarball——等价包管理器对 dist.integrity 的校验,
 * 拦截 CDN 截断/缓存损坏/中途篡改。SRI 形如 "sha512-<base64>"(取 sha512 段)。
 */
export function verifyTarballIntegrity(tgz: Buffer, integrity: string, source: string): void {
  const sri = integrity.split(/\s+/).find((entry) => entry.startsWith("sha512-"));
  if (!sri) throw new Error(`unsupported integrity for ${source}: ${integrity}`);
  const expected = sri.slice("sha512-".length);
  const actual = createHash("sha512").update(tgz).digest("base64");
  if (actual !== expected) {
    throw new Error(`integrity mismatch for ${source}: expected ${expected}, got ${actual}`);
  }
}
