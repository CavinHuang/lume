/**
 * extract_style.mjs - 从 Office 文档中提取设计样式规范
 *
 * 移植自 Alice 的 office_extract_style.ts，使用纯 ESM JS + 内置 zlib 处理 ZIP。
 * 支持 .pptx 和 .docx 格式，输出 YAML 格式的样式规范。
 *
 * 用法: node extract_style.mjs <input_path> [output_path]
 *   input_path  - Office 文件路径 (.pptx 或 .docx)
 *   output_path - 输出 YAML 文件路径（可选，默认: <input>.style.yaml）
 *
 * 输出 JSON:
 *   { ok, path, output_path, format, source,
 *     slide_size, color_palette, fonts, spacing,
 *     layout_patterns, theme_name, slide_count,
 *     page, styles, has_header, has_footer }
 */

import { readFile, writeFile, existsSync } from "node:fs/promises";
import { createGunzip } from "node:zlib";

// ── Minimal ZIP reader (same as add_slide.mjs) ─────────────────

const ZIP_SIGNATURE = 0x04034b50;
const CD_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const COMPRESSION_STORE = 0;
const COMPRESSION_DEFLATE = 8;

function readUint32At(view, offset) {
  return view.getUint32(offset, true);
}

function readUint16At(view, offset) {
  return view.getUint16(offset, true);
}

function readLocalHeader(buf, offset) {
  const end = Math.min(offset + 30, buf.length);
  const view = new DataView(buf.buffer, buf.byteOffset + offset, end - offset);
  return {
    compression: readUint16At(view, 8),
    compressedSize: readUint32At(view, 18),
    uncompressedSize: readUint32At(view, 22),
    nameLength: readUint16At(view, 26),
    extraLength: readUint16At(view, 28),
  };
}

async function readZipEntries(zipPath) {
  const buf = Buffer.from(await readFile(zipPath));
  const entries = [];
  let offset = 0;

  while (offset < buf.length - 4) {
    const sig = buf.readUInt32LE(offset);
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
      });
      offset = dataOffset + header.compressedSize;
    } else if (sig === CD_SIGNATURE || sig === EOCD_SIGNATURE) {
      break;
    } else {
      break;
    }
  }
  return entries;
}

async function readZipEntryContent(buf, entry) {
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
    gunzip.end(data);
  });
}

// ── Style extraction helpers ───────────────────────────────────

function extractColors(xml) {
  const colors = new Map();
  const re = /val="([0-9A-Fa-f]{6})"/g;
  let match;
  while ((match = re.exec(xml)) !== null) {
    const color = match[1].toLowerCase();
    colors.set(color, (colors.get(color) || 0) + 1);
  }
  return colors;
}

function extractFontInfo(xml) {
  const fonts = new Map();
  const rprRe = /<a:rPr[^>]*>/g;
  const fontRe = /typeface="([^"]+)"/g;

  let rprMatch;
  while ((rprMatch = rprRe.exec(xml)) !== null) {
    const rpr = rprMatch[0];
    const szMatch = rpr.match(/sz="(\d+)"/);
    const isBold = /<a:b\b/.test(rpr);
    const size = szMatch ? parseInt(szMatch[1], 10) / 100 : 0;
    let fontName = "default";
    const fontMatch = rpr.match(/typeface="([^"]+)"/);
    if (fontMatch) fontName = fontMatch[1];

    const existing = fonts.get(fontName) || { count: 0, sizes: [], bold: false };
    existing.count++;
    if (size > 0) existing.sizes.push(size);
    if (isBold) existing.bold = true;
    fonts.set(fontName, existing);
  }

  let fontMatch;
  while ((fontMatch = fontRe.exec(xml)) !== null) {
    const name = fontMatch[1];
    const existing = fonts.get(name) || { count: 0, sizes: [], bold: false };
    existing.count++;
    fonts.set(name, existing);
  }
  return fonts;
}

function extractLayouts(xml) {
  const layouts = [];
  if (/<p:sp.*<p:txBody/.test(xml)) layouts.push("textBox");
  if (/<p:graphicFrame/.test(xml)) layouts.push("table");
  if (/<p:pic/.test(xml)) layouts.push("image");
  if (/<p:chart/.test(xml)) layouts.push("chart");
  if (/<p:cxnSp/.test(xml)) layouts.push("shape");
  if (/<p:grpSp/.test(xml)) layouts.push("group");
  return layouts;
}

function emuToInches(emu) {
  return Math.round((emu / 914400) * 1000) / 1000;
}

function halfPtToPt(halfPt) {
  return halfPt / 2;
}

// ── PPTX style extraction ──────────────────────────────────────

async function extractPptxStyle(buf, entries, sourceName) {
  const presXmlPath = "ppt/presentation.xml";
  let slideWidth = 12192000; // default 16:9
  let slideHeight = 6858000;

  const presEntry = entries.find((e) => e.name === presXmlPath);
  if (presEntry) {
    const presXml = await readZipEntryContent(buf, presEntry);
    const cxMatch = presXml.match(/cx="(\d+)"/);
    const cyMatch = presXml.match(/cy="(\d+)"/);
    if (cxMatch) slideWidth = parseInt(cxMatch[1], 10);
    if (cyMatch) slideHeight = parseInt(cyMatch[1], 10);
  }

  const colorMap = new Map();
  const fontMap = new Map();
  const layoutPatterns = [];
  let slideCount = 0;

  // Scan all slides
  const slidesDir = "ppt/slides/";
  const slideEntries = entries
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  slideCount = slideEntries.length;

  for (const entry of slideEntries) {
    const xml = await readZipEntryContent(buf, entry);

    const colors = extractColors(xml);
    for (const [color, count] of colors) {
      colorMap.set(color, (colorMap.get(color) || 0) + count);
    }

    const fonts = extractFontInfo(xml);
    for (const [name, info] of fonts) {
      const existing = fontMap.get(name) || { count: 0, sizes: [], bold: false };
      existing.count += info.count;
      existing.sizes.push(...info.sizes);
      if (info.bold) existing.bold = true;
      fontMap.set(name, existing);
    }

    layoutPatterns.push(...extractLayouts(xml));
  }

  // Scan theme
  const themePath = "ppt/theme/theme1.xml";
  const themeEntry = entries.find((e) => e.name === themePath);
  let themeName = "Office Theme";
  if (themeEntry) {
    const themeXml = await readZipEntryContent(buf, themeEntry);
    const nameMatch = themeXml.match(/name="([^"]+)"/);
    if (nameMatch) themeName = nameMatch[1];

    const themeColors = extractColors(themeXml);
    for (const [color, count] of themeColors) {
      colorMap.set(color, (colorMap.get(color) || 0) + count);
    }
  }

  // Build palette
  const sortedColors = [...colorMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([color, count]) => ({ color, count, usage: "" }));

  const primary = sortedColors[0]?.color || "333333";
  const secondary = sortedColors[1]?.color || "666666";
  const accent = sortedColors[2]?.color || "999999";

  // Build font info
  const sortedFonts = [...fontMap.entries()]
    .sort((a, b) => b[1].count - a[1].count);

  const fonts = {};
  if (sortedFonts[0]) {
    const avgSize = sortedFonts[0][1].sizes.length > 0
      ? Math.round(sortedFonts[0][1].sizes.reduce((a, b) => a + b, 0) / sortedFonts[0][1].sizes.length)
      : 14;
    fonts.primary = { name: sortedFonts[0][0], size_pt: avgSize, bold: sortedFonts[0][1].bold };
  }
  if (sortedFonts[1]) {
    const avgSize = sortedFonts[1][1].sizes.length > 0
      ? Math.round(sortedFonts[1][1].sizes.reduce((a, b) => a + b, 0) / sortedFonts[1][1].sizes.length)
      : 14;
    fonts.secondary = { name: sortedFonts[1][0], size_pt: avgSize, bold: sortedFonts[1][1].bold };
  }

  // Layout stats
  const layoutCounts = new Map();
  for (const layout of layoutPatterns) {
    layoutCounts.set(layout, (layoutCounts.get(layout) || 0) + 1);
  }
  const layoutStats = [...layoutCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => ({ type, count, description: "" }));

  return {
    source: sourceName,
    format: "pptx",
    slide_size: { width_inches: emuToInches(slideWidth), height_inches: emuToInches(slideHeight) },
    color_palette: { primary, secondary, accent, all_colors: sortedColors.slice(0, 20) },
    fonts,
    spacing: { margin_left_inches: 0.7, margin_right_inches: 0.7, margin_top_inches: 0.5, margin_bottom_inches: 0.5 },
    layout_patterns: layoutStats,
    theme_name: themeName,
    slide_count: slideCount,
  };
}

// ── DOCX style extraction ──────────────────────────────────────

async function extractDocxStyle(buf, entries, sourceName) {
  const stylesPath = "word/styles.xml";
  const docPath = "word/document.xml";

  let pageSize = "letter";
  let orientation = "portrait";
  let margins = { top_dxa: 1440, bottom_dxa: 1440, left_dxa: 1440, right_dxa: 1440 };

  // Parse page setup
  const docEntry = entries.find((e) => e.name === docPath);
  if (docEntry) {
    const docXml = await readZipEntryContent(buf, docEntry);
    const pgSzMatch = docXml.match(/<w:pgSz[^>]*>/);
    if (pgSzMatch) {
      const w = pgSzMatch[0].match(/w:w="(\d+)"/);
      const h = pgSzMatch[0].match(/w:h="(\d+)"/);
      if (w && h) {
        const wVal = parseInt(w[1], 10);
        const hVal = parseInt(h[1], 10);
        if (Math.abs(wVal - 12240) < 200 && Math.abs(hVal - 15840) < 200) pageSize = "letter";
        else if (Math.abs(wVal - 11906) < 200 && Math.abs(hVal - 16838) < 200) pageSize = "a4";
      }
      if (/orient="landscape"/.test(pgSzMatch[0])) orientation = "landscape";
    }

    const pgMarMatch = docXml.match(/<w:pgMar[^>]*>/);
    if (pgMarMatch) {
      const top = pgMarMatch[0].match(/w:top="(\d+)"/);
      const bottom = pgMarMatch[0].match(/w:bottom="(\d+)"/);
      const left = pgMarMatch[0].match(/w:left="(\d+)"/);
      const right = pgMarMatch[0].match(/w:right="(\d+)"/);
      if (top) margins.top_dxa = parseInt(top[1], 10);
      if (bottom) margins.bottom_dxa = parseInt(bottom[1], 10);
      if (left) margins.left_dxa = parseInt(left[1], 10);
      if (right) margins.right_dxa = parseInt(right[1], 10);
    }
  }

  // Parse styles
  const styles = {};
  const stylesEntry = entries.find((e) => e.name === stylesPath);
  if (stylesEntry) {
    const stylesXml = await readZipEntryContent(buf, stylesEntry);
    const styleRe = /<w:style\s[^>]*w:styleId="([^"]+)"[^>]*>([\s\S]*?)<\/w:style>/g;
    let match;
    while ((match = styleRe.exec(stylesXml)) !== null) {
      const styleId = match[1];
      const content = match[2];

      const fontMatch = content.match(/<w:rFonts[^>]*w:ascii="([^"]+)"/);
      const szMatch = content.match(/<w:sz\s+w:val="(\d+)"/);
      const isBold = /<w:b\b/.test(content) && !/<w:b\s+w:val="0"/.test(content);
      const isItalic = /<w:i\b/.test(content) && !/<w:i\s+w:val="0"/.test(content);
      const colorMatch = content.match(/<w:color\s+w:val="([0-9A-Fa-f]{6})"/);
      const spacingBefore = content.match(/<w:spacing[^>]*w:before="(\d+)"/);
      const spacingAfter = content.match(/<w:spacing[^>]*w:after="(\d+)"/);
      const lineSpacing = content.match(/<w:spacing[^>]*w:line="(\d+)"/);

      if (fontMatch || szMatch) {
        styles[styleId] = {
          name: fontMatch?.[1] || "default",
          size_pt: szMatch ? halfPtToPt(parseInt(szMatch[1], 10)) : undefined,
          bold: isBold || undefined,
          italic: isItalic || undefined,
          color: colorMatch?.[1],
          spacing_before_pt: spacingBefore ? halfPtToPt(parseInt(spacingBefore[1], 10)) : undefined,
          spacing_after_pt: spacingAfter ? halfPtToPt(parseInt(spacingAfter[1], 10)) : undefined,
          line_spacing: lineSpacing ? parseInt(lineSpacing[1], 10) / 240 : undefined,
        };
      }
    }
  }

  return {
    source: sourceName,
    format: "docx",
    page: { size: pageSize, orientation, margins },
    styles,
    has_header: entries.some((e) => e.name === "word/header1.xml"),
    has_footer: entries.some((e) => e.name === "word/footer1.xml"),
  };
}

// ── Main ───────────────────────────────────────────────────────

const args = process.argv.slice(2);
if (args.length < 1) {
  console.log(JSON.stringify({ ok: false, error: "Usage: extract_style.mjs <input_path> [output_path]" }));
  process.exit(1);
}

const [inputPath, outputPath] = args;

try {
  const buf = Buffer.from(await readFile(inputPath));
  const entries = await readZipEntries(inputPath);
  const fileName = basename(inputPath);

  // Detect format
  const hasPptx = entries.some((e) => e.name.startsWith("ppt/"));
  const hasDocx = entries.some((e) => e.name.startsWith("word/"));

  let spec;
  if (hasPptx) {
    spec = await extractPptxStyle(buf, entries, fileName);
  } else if (hasDocx) {
    spec = await extractDocxStyle(buf, entries, fileName);
  } else {
    throw new Error(`不支持的文件格式，仅支持 .pptx 和 .docx`);
  }

  // Write YAML output
  const yamlPath = outputPath || inputPath.replace(/\.\w+$/, ".style.yaml");
  await writeFile(yamlPath, specToYaml(spec), "utf-8");

  console.log(JSON.stringify({
    ok: true,
    path: inputPath,
    output_path: yamlPath,
    ...spec,
  }, null, 2));
} catch (err) {
  console.log(JSON.stringify({ ok: false, error: err.message }));
  process.exit(1);
}

// ── Simple YAML serializer ─────────────────────────────────────

function specToYaml(obj, indent = 0) {
  const prefix = "  ".repeat(indent);
  if (obj === null || obj === undefined) return "null";
  if (typeof obj === "string") return `"${obj.replace(/"/g, '\\"')}"`;
  if (typeof obj === "number" || typeof obj === "boolean") return String(obj);

  if (Array.isArray(obj)) {
    if (obj.length === 0) return "[]";
    return "\n" + obj.map((item) => `${prefix}- ${specToYaml(item, indent + 1)}`).join("\n");
  }

  if (typeof obj === "object") {
    const entries = Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== "");
    if (entries.length === 0) return "{}";
    return (
      "\n" +
      entries
        .map(([key, value]) => {
          const val = specToYaml(value, indent + 1);
          return val.startsWith("\n") ? `${prefix}${key}:${val}` : `${prefix}${key}: ${val}`;
        })
        .join("\n")
    );
  }

  return String(obj);
}
