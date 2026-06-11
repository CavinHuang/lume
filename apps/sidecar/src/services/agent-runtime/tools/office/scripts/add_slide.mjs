/**
 * add_slide.mjs - 向 PPTX 添加幻灯片
 *
 * 移植自 Alice 的 pptx_add_slide.ts，使用纯 ESM JS + 内置 zlib 处理 ZIP。
 * 操作 OOXML (PPTX) 内部结构：复制/创建 slide XML，更新 [Content_Types].xml 和 presentation.xml.rels。
 *
 * 用法: node add_slide.mjs <input_path> <output_path> [source]
 *   input_path  - 输入 PPTX 文件路径
 *   output_path - 输出 PPTX 文件路径
 *   source      - 可选: slideN.xml (复制现有), slideLayoutN.xml (基于布局空白), 或空白
 *
 * 输出 JSON:
 *   { ok, input_path, output_path, added_slide, new_slide_file,
 *     new_slide_number, sld_id, r_id, message }
 */

import { readFile, writeFile, copyFile, existsSync, readdir } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { createGunzip, createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";

// ── Minimal ZIP read/write (no external deps) ──────────────────

const ZIP_SIGNATURE = 0x04034b50; // Local file header
const CD_SIGNATURE = 0x02014b50;  // Central directory
const EOCD_SIGNATURE = 0x06054b50; // End of central directory

const COMPRESSION_STORE = 0;
const COMPRESSION_DEFLATE = 8;

function readUint32(buf, offset) {
  return buf.readUInt32LE(offset);
}

function readUint16(buf, offset) {
  return (buf[offset] | (buf[offset + 1] << 8)) >>> 0;
}

function readUint16At(dataView, offset) {
  return dataView.getUint16(offset, true);
}

function readUint32At(dataView, offset) {
  return dataView.getUint32(offset, true);
}

/** Read a local file header */
function readLocalHeader(buf, offset) {
  const view = new DataView(buf.buffer, buf.byteOffset + offset, 46);
  return {
    signature: readUint32At(view, 0),
    versionNeeded: readUint16At(view, 4),
    flags: readUint16At(view, 6),
    compression: readUint16At(view, 8),
    modTime: readUint16At(view, 10),
    modDate: readUint16At(view, 12),
    crc32: readUint32At(view, 14),
    compressedSize: readUint32At(view, 18),
    uncompressedSize: readUint32At(view, 22),
    nameLength: readUint16At(view, 26),
    extraLength: readUint16At(view, 28),
  };
}

/**
 * Read ZIP entries using local file headers (no central directory needed).
 * Returns array of { name, offset, compressedSize, uncompressedSize, compression, isDirectory }.
 */
async function readZipEntries(zipPath) {
  const buf = Buffer.from(await readFile(zipPath));
  const entries = [];
  let offset = 0;

  while (offset < buf.length - 4) {
    const sig = readUint32(buf, offset);
    if (sig === ZIP_SIGNATURE) {
      const header = readLocalHeader(buf, offset);
      const name = buf.toString("utf-8", offset + 30, offset + 30 + header.nameLength);
      const dataOffset = offset + 30 + header.nameLength + header.extraLength;
      entries.push({
        name,
        offset: dataOffset,
        compressedSize: header.compressedSize,
        uncompressedSize: header.uncompressedSize,
        compression: header.compression,
        isDirectory: name.endsWith("/"),
      });
      offset = dataOffset + header.compressedSize;
    } else if (sig === CD_SIGNATURE || sig === EOCD_SIGNATURE) {
      break; // Central directory or EOCD - stop scanning
    } else {
      break; // Unknown signature
    }
  }

  return entries;
}

/** Read file content from ZIP by entry */
async function readZipEntryContent(zipPath, entry) {
  const buf = Buffer.from(await readFile(zipPath));
  const data = buf.subarray(entry.offset, entry.offset + entry.compressedSize);

  if (entry.compression === COMPRESSION_STORE) {
    return data.toString("utf-8");
  }

  return new Promise((resolve, reject) => {
    const gunzip = createGunzip();
    const chunks = [];
    gunzip.on("data", (chunk) => chunks.push(chunk));
    gunzip.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    gunzip.on("error", reject);
    data.on("error", reject);
    gunzip.end(data);
  });
}

/** Write a ZIP file with given entries */
async function writeZipFile(outputPath, entries) {
  const { Writable } = await import("node:stream");
  const chunks = [];

  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      callback();
    },
  });

  await new Promise((resolve, reject) => {
    stream.on("finish", resolve);
    stream.on("error", reject);
    stream.end();
  });

  const buf = Buffer.concat(chunks);

  // Build local file headers + data
  const localParts = [];
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, "utf-8");
    const compressedData = entry.compression === COMPRESSION_DEFLATE
      ? await compressBuffer(entry.data)
      : entry.data;
    const crc = crc32(entry.data);
    const header = Buffer.alloc(30);
    const view = new DataView(header.buffer);

    view.setUint32(0, ZIP_SIGNATURE, true);
    view.setUint16(4, 0x002d, true);  // version needed
    view.setUint16(6, 0x0000, true);  // flags
    view.setUint16(8, entry.compression, true);
    view.setUint16(10, 0x0000, true); // mod time
    view.setUint16(12, 0x0000, true); // mod date
    view.setUint32(14, crc, true);
    view.setUint32(18, compressedData.length, true);
    view.setUint32(22, entry.data.length, true);
    view.setUint16(26, nameBytes.length, true);
    view.setUint16(28, 0x0000, true); // extra length

    localParts.push(Buffer.concat([header, nameBytes, compressedData]));
  }

  const localEnd = Buffer.concat(localParts);

  // Build central directory
  const cdParts = [];
  let cdOffset = 0;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const nameBytes = Buffer.from(entry.name, "utf-8");
    const compressedData = entry.compression === COMPRESSION_DEFLATE
      ? await compressBuffer(entry.data)
      : entry.data;
    const crc = crc32(entry.data);

    // Calculate local header offset (cumulative size of previous entries)
    let localOffset = 0;
    for (let j = 0; j < i; j++) {
      localOffset += 30 + Buffer.byteLength(entries[j].name, "utf-8") + 0; // extra = 0
      localOffset += entries[j].compression === COMPRESSION_DEFLATE
        ? (await compressBuffer(entries[j].data)).length
        : entries[j].data.length;
    }

    const header = Buffer.alloc(46);
    const view = new DataView(header.buffer);

    view.setUint32(0, CD_SIGNATURE, true);
    view.setUint8(4, 0x31);  // version made by
    view.setUint8(5, 0x3d);  // version needed
    view.setUint16(6, 0x0000, true); // flags
    view.setUint16(8, entry.compression, true);
    view.setUint16(10, 0x0000, true);
    view.setUint16(12, 0x0000, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, compressedData.length, true);
    view.setUint32(22, entry.data.length, true);
    view.setUint16(26, nameBytes.length, true);
    view.setUint16(28, 0x0000, true); // extra length
    view.setUint16(30, 0x0000, true); // comment length
    view.setUint16(32, 0x0000, true); // disk number
    view.setUint16(34, 0x0000, true); // internal attrs
    view.setUint32(36, 0x00000000, true); // external attrs
    view.setUint32(40, localOffset, true); // local header offset

    cdParts.push(Buffer.concat([header, nameBytes]));
  }

  const cdEnd = Buffer.concat(cdParts);
  const cdSize = cdEnd.length;

  // EOCD
  const eocd = Buffer.alloc(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, EOCD_SIGNATURE, true);
  eocdView.setUint16(4, 0x0000, true);  // disk count
  eocdView.setUint16(6, 0x0000, true);  // central disk
  eocdView.setUint16(8, entries.length, true); // total entries
  eocdView.setUint16(10, entries.length, true); // entries on disk
  eocdView.setUint32(12, cdSize, true);
  eocdView.setUint32(16, cdOffset, true); // CD offset - will be fixed below
  eocdView.setUint16(20, 0x0000, true); // comment length

  // Fix CD offset
  eocdView.setUint32(16, localEnd.length, true);

  await writeFile(outputPath, Buffer.concat([localEnd, cdEnd, eocd]));
}

function compressBuffer(data) {
  return new Promise((resolve, reject) => {
    const gzip = createGzip();
    const chunks = [];
    gzip.on("data", (chunk) => chunks.push(chunk));
    gzip.on("end", () => resolve(Buffer.concat(chunks)));
    gzip.on("error", reject);
    gzip.end(data);
  });
}

// CRC32 implementation
function crc32(data) {
  let crc = 0xffffffff;
  const table = getCrcTable();
  for (let i = 0; i < data.length; i++) {
    crc = table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const crcTable = new Uint32Array(256);
function getCrcTable() {
  if (crcTable[1] !== 0) return crcTable;
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    crcTable[n] = c;
  }
  return crcTable;
}

// ── Core Logic (ported from Alice) ────────────────────────────

async function addSlideToPptx(inputPath, outputPath, source) {
  // 1. Copy input to output
  await copyFile(inputPath, outputPath);

  // 2. Read existing entries
  const entries = await readZipEntries(outputPath);

  // 3. Determine next slide number
  const slideEntries = entries.filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name));
  const existingNums = slideEntries.map((e) => {
    const m = e.name.match(/slide(\d+)\.xml$/);
    return m ? parseInt(m[1], 10) : 0;
  });
  const nextNum = existingNums.length > 0 ? Math.max(...existingNums) + 1 : 1;
  const slideFileName = `slide${nextNum}.xml`;

  // Build new entries list (start with existing, add new)
  const newEntries = [...entries];
  let rId = "";

  // 4. Create slide based on source type
  if (source && /^slide\d+\.xml$/.test(source) && !source.includes("Layout")) {
    // Copy existing slide
    const srcName = `ppt/slides/${source}`;
    const srcEntry = entries.find((e) => e.name === srcName);
    if (!srcEntry) throw new Error(`源幻灯片不存在: ${source}`);

    let slideContent = await readZipEntryContent(outputPath, srcEntry);

    // Remove notesSlide references in rels
    const srcRelsName = `ppt/slides/_rels/${source}.rels`;
    const srcRelsEntry = entries.find((e) => e.name === srcRelsName);
    if (srcRelsEntry) {
      let relsContent = await readZipEntryContent(outputPath, srcRelsEntry);
      relsContent = relsContent.replace(
        /<Relationship[^>]*Type="[^"]*notesSlide[^"]*"[^>]*\/>/g,
        ""
      );
      newEntries.push({
        name: `ppt/slides/_rels/${slideFileName}.rels`,
        data: Buffer.from(relsContent, "utf-8"),
        compression: COMPRESSION_DEFLATE,
      });
    }

    newEntries.push({
      name: `ppt/slides/${slideFileName}`,
      data: Buffer.from(slideContent, "utf-8"),
      compression: COMPRESSION_DEFLATE,
    });
  } else if (source && source.includes("Layout")) {
    // Create blank slide based on layout
    const layoutNum = source.match(/(\d+)/)?.[1] || "1";
    const layoutRef = `../slideLayouts/slideLayout${layoutNum}.xml`;

    const blankSlide = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
       xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
       xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr>
        <p:cNvPr id="1" name=""/>
        <p:cNvGrpSpPr/>
        <p:nvPr/>
      </p:nvGrpSpPr>
      <p:grpSpPr/>
    </p:spTree>
  </p:cSld>
</p:sld>`;

    const relsContent = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="${layoutRef}"/>
</Relationships>`;

    newEntries.push({
      name: `ppt/slides/${slideFileName}`,
      data: Buffer.from(blankSlide, "utf-8"),
      compression: COMPRESSION_DEFLATE,
    });
    newEntries.push({
      name: `ppt/slides/_rels/${slideFileName}.rels`,
      data: Buffer.from(relsContent, "utf-8"),
      compression: COMPRESSION_DEFLATE,
    });
  } else {
    // Default: blank slide
    const blankSlide = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
       xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
       xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr>
        <p:cNvPr id="1" name=""/>
        <p:cNvGrpSpPr/>
        <p:nvPr/>
      </p:nvGrpSpPr>
      <p:grpSpPr/>
    </p:spTree>
  </p:cSld>
</p:sld>`;

    newEntries.push({
      name: `ppt/slides/${slideFileName}`,
      data: Buffer.from(blankSlide, "utf-8"),
      compression: COMPRESSION_DEFLATE,
    });
  }

  // 5. Update [Content_Types].xml
  const ctName = "[Content_Types].xml";
  const ctEntry = entries.find((e) => e.name === ctName);
  if (ctEntry) {
    let ctContent = await readZipEntryContent(outputPath, ctEntry);
    const override = `<Override PartName="/ppt/slides/${slideFileName}" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`;
    if (!ctContent.includes(`/ppt/slides/${slideFileName}`)) {
      ctContent = ctContent.replace("</Types>", `${override}\n</Types>`);
      // Update in entries
      const idx = newEntries.findIndex((e) => e.name === ctName);
      if (idx >= 0) {
        newEntries[idx] = { ...newEntries[idx], data: Buffer.from(ctContent, "utf-8") };
      }
    }
  }

  // 6. Update presentation.xml.rels
  const presRelsName = "ppt/_rels/presentation.xml.rels";
  const presRelsEntry = entries.find((e) => e.name === presRelsName);
  if (presRelsEntry) {
    let relsContent = await readZipEntryContent(outputPath, presRelsEntry);
    const maxRId = extractMaxRId(relsContent);
    rId = `rId${maxRId + 1}`;
    const newRel = `<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/${slideFileName}"/>`;
    if (!relsContent.includes(`slides/${slideFileName}`)) {
      relsContent = relsContent.replace("</Relationships>", `${newRel}\n</Relationships>`);
      const idx = newEntries.findIndex((e) => e.name === presRelsName);
      if (idx >= 0) {
        newEntries[idx] = { ...newEntries[idx], data: Buffer.from(relsContent, "utf-8") };
      }
    }
  } else {
    rId = "rId1";
  }

  // 7. Calculate sldId
  let sldId = 256;
  const presEntry = entries.find((e) => e.name === "ppt/presentation.xml");
  if (presEntry) {
    const presContent = await readZipEntryContent(outputPath, presEntry);
    const maxId = extractMaxId(presContent);
    sldId = maxId >= 255 ? maxId + 1 : 256;
  }

  // 8. Write updated ZIP
  await writeZipFile(outputPath, newEntries);

  return {
    ok: true,
    input_path: inputPath,
    output_path: outputPath,
    added_slide: true,
    new_slide_file: slideFileName,
    new_slide_number: nextNum,
    sld_id: sldId,
    r_id: rId,
    message: `幻灯片 ${slideFileName} 添加成功 (sldId=${sldId}, ${rId})`,
  };
}

function extractMaxRId(xml) {
  const re = /Id="rId(\d+)"/g;
  let match;
  let max = 0;
  while ((match = re.exec(xml)) !== null) {
    const n = parseInt(match[1], 10);
    if (n > max) max = n;
  }
  return max;
}

function extractMaxId(xml) {
  const re = /id="(\d+)"/g;
  let match;
  let max = 255;
  while ((match = re.exec(xml)) !== null) {
    const n = parseInt(match[1], 10);
    if (n > max) max = n;
  }
  return max;
}

// ── Main ───────────────────────────────────────────────────────

const args = process.argv.slice(2);
if (args.length < 2) {
  console.log(JSON.stringify({ ok: false, error: "Usage: add_slide.mjs <input_path> <output_path> [source]" }));
  process.exit(1);
}

const [inputPath, outputPath, source] = args;

addSlideToPptx(inputPath, outputPath, source)
  .then((result) => {
    console.log(JSON.stringify(result, null, 2));
  })
  .catch((err) => {
    console.log(JSON.stringify({ ok: false, error: err.message, stack: err.stack }));
    process.exit(1);
  });
