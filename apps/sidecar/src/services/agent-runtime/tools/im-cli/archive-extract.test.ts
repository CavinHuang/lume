import { test, expect, describe } from "bun:test";
import { createHash } from "node:crypto";
import { deflateRawSync, gunzipSync, gzipSync } from "node:zlib";
import {
  extractFileFromTar,
  extractFileFromZip,
  verifySha256,
  verifyTarballIntegrity,
} from "./archive-extract";

/** 构造标准 ustar tar(extractFileFromTar 不校验 checksum,该字段填 0 即可)。 */
function makeTar(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512, 0);
    header.write(entry.name, 0, "utf-8");
    const sizeOct = entry.data.length.toString(8).padStart(11, "0") + "\0";
    header.write(sizeOct, 124, "ascii"); // size @124(octal, NUL 终止)
    header.write("0", 156, "ascii"); // typeflag @156 = 普通文件
    header.write("ustar", 257, "ascii"); // ustar magic
    blocks.push(header, entry.data);
    const pad = (512 - (entry.data.length % 512)) % 512;
    if (pad) blocks.push(Buffer.alloc(pad, 0));
  }
  blocks.push(Buffer.alloc(1024, 0)); // 2 个全零块 = EOF
  return Buffer.concat(blocks);
}

/** 构造最小 zip(extractFileFromZip 不读 CRC,该字段填 0)。deflate=true 用 method 8。 */
function makeZip(entries: Array<{ name: string; data: Buffer; deflate?: boolean }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf-8");
    const method = entry.deflate ? 8 : 0;
    const compressed = entry.deflate ? deflateRawSync(entry.data) : entry.data;
    const local = Buffer.alloc(30, 0);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(compressed.length, 18); // compressed size
    local.writeUInt32LE(entry.data.length, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    const localBlock = Buffer.concat([local, nameBuf, compressed]);
    locals.push(localBlock);
    const central = Buffer.alloc(46, 0);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42); // local header offset
    centrals.push(Buffer.concat([central, nameBuf]));
    offset += localBlock.length;
  }
  const centralStart = offset;
  const eocd = Buffer.alloc(22, 0);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralStart, 16);
  return Buffer.concat([...locals, ...centrals, eocd]);
}

describe("archive-extract", () => {
  test("extracts a file from a gzipped ustar tarball by path", () => {
    const tar = makeTar([
      { name: "package/package.json", data: Buffer.from("{}") },
      { name: "package/bin/wecom-cli", data: Buffer.from("BINARY") },
    ]);
    const extracted = extractFileFromTar(gunzipSync(gzipSync(tar)), "package/bin/wecom-cli");
    expect(extracted).not.toBeNull();
    expect(extracted!.toString("utf-8")).toBe("BINARY");
  });

  test("returns null when the wanted file is absent from the tar", () => {
    const tar = makeTar([{ name: "package/dws", data: Buffer.from("x") }]);
    expect(extractFileFromTar(tar, "package/missing")).toBeNull();
  });

  test("throws on a truncated tar that declares more bytes than present", () => {
    const header = Buffer.alloc(512, 0);
    header.write("pkg/big", 0, "utf-8");
    header.write("00000007777\0", 124, "ascii"); // 声明 4095 字节
    header.write("0", 156, "ascii");
    const truncated = Buffer.concat([header]); // 无数据块
    expect(() => extractFileFromTar(truncated, "pkg/big")).toThrow(/truncated tar/);
  });

  test("extracts a stored(method 0)entry from a zip", () => {
    const zip = makeZip([{ name: "dws.exe", data: Buffer.from("EXE-BODY") }]);
    const extracted = extractFileFromZip(zip, "dws.exe");
    expect(extracted).not.toBeNull();
    expect(extracted!.toString("utf-8")).toBe("EXE-BODY");
  });

  test("extracts a deflated(method 8)entry from a zip", () => {
    const zip = makeZip([{ name: "lark-cli.exe", data: Buffer.from("deflated-body"), deflate: true }]);
    const extracted = extractFileFromZip(zip, "lark-cli.exe");
    expect(extracted).not.toBeNull();
    expect(extracted!.toString("utf-8")).toBe("deflated-body");
  });

  test("returns null when the wanted entry is absent from the zip", () => {
    const zip = makeZip([{ name: "a", data: Buffer.from("x") }]);
    expect(extractFileFromZip(zip, "missing")).toBeNull();
  });

  test("verifySha256 passes on match and throws on mismatch", () => {
    const data = Buffer.from("checksum-me");
    const digest = createHash("sha256").update(data).digest("hex");
    expect(() => verifySha256(data, digest, "asset")).not.toThrow();
    expect(() => verifySha256(data, "0".repeat(64), "asset")).toThrow(/sha256 mismatch/);
  });

  test("verifyTarballIntegrity validates an SRI sha512 integrity string", () => {
    const tgz = Buffer.from("tarball-bytes");
    const b64 = createHash("sha512").update(tgz).digest("base64");
    expect(() => verifyTarballIntegrity(tgz, `sha512-${b64}`, "src")).not.toThrow();
    expect(() => verifyTarballIntegrity(tgz, "sha512-AAAA==", "src")).toThrow(/integrity mismatch/);
    expect(() => verifyTarballIntegrity(tgz, "md5-deadbeef", "src")).toThrow(/unsupported integrity/);
  });
});
