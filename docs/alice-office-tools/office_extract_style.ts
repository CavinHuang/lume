/**
 * office_extract_style - 从 Office 文档中提取设计样式规范
 *
 * Tier: ondemand | Category: file | isConcurrencySafe: true
 * 依赖: office_unpack (内部调用) + XML 解析
 * 支持: .pptx 和 .docx 格式
 *
 * 原始源码位置: runtime-Biw3JkjY.js -> Hd={name:"office_extract_style",...}
 * 变量映射:
 *   ed = unpackOffice() 解压函数
 *   Sd = emuToInches() EMU 转英寸
 *   Ad = extractColors() 从 XML 提取颜色
 *   Td = extractFonts() 从 XML 提取字体
 *   vd = extractLayouts() 从 XML 提取布局模式
 *   $d = halfPtToPt() 半磅转磅
 *   Ed = specToYaml() 规范转 YAML
 *   kn = fs.rm (recursive cleanup)
 *   bn = fs.readFile
 */

import { z } from "zod";
import { resolve, isAbsolute, join, basename } from "path";
import { readFile, writeFile, rm } from "fs/promises";
import { existsSync } from "fs";

// ── 辅助函数 ──

/** EMU (English Metric Units) 转英寸 */
function emuToInches(emu: number): number {
  return Math.round((emu / 914400) * 1000) / 1000;
}

/** 半磅转磅 (w:sz 的值是半磅单位) */
function halfPtToPt(halfPt: number): number {
  return halfPt / 2;
}

/** 从 XML 提取颜色 (格式: "RRGGBB") */
function extractColors(xml: string): Map<string, number> {
  const colors = new Map<string, number>();
  // 匹配 srgbClr val="XXXXXX" 和各种颜色属性
  const re = /val="([0-9A-Fa-f]{6})"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) {
    const color = match[1].toLowerCase();
    colors.set(color, (colors.get(color) || 0) + 1);
  }
  return colors;
}

/** 从 XML 提取字体信息 */
function extractFontInfo(xml: string): Map<string, { count: number; sizes: number[]; bold: boolean }> {
  const fonts = new Map<string, { count: number; sizes: number[]; bold: boolean }>();
  // 匹配 <a:rPr lang="..." sz="NNNN" ...> 和 <a:rFont typeface="..."
  const rprRe = /<a:rPr[^>]*>/g;
  const fontRe = /typeface="([^"]+)"/g;

  let rprMatch: RegExpExecArray | null;
  while ((rprMatch = rprRe.exec(xml)) !== null) {
    const rpr = rprMatch[0];
    const szMatch = rpr.match(/sz="(\d+)"/);
    const isBold = /<a:b\b/.test(rpr);
    const size = szMatch ? parseInt(szMatch[1], 10) / 100 : 0; // 百分之一磅

    // 查找同一 run 中的字体
    let fontName = "default";
    const fontMatch = rpr.match(/typeface="([^"]+)"/);
    if (fontMatch) fontName = fontMatch[1];

    const existing = fonts.get(fontName) || { count: 0, sizes: [] as number[], bold: false };
    existing.count++;
    if (size > 0) existing.sizes.push(size);
    if (isBold) existing.bold = true;
    fonts.set(fontName, existing);
  }

  // 也搜索 typeface 属性
  let fontMatch: RegExpExecArray | null;
  while ((fontMatch = fontRe.exec(xml)) !== null) {
    const name = fontMatch[1];
    const existing = fonts.get(name) || { count: 0, sizes: [] as number[], bold: false };
    existing.count++;
    fonts.set(name, existing);
  }

  return fonts;
}

/** 从幻灯片 XML 提取布局模式 */
function extractLayouts(xml: string): string[] {
  const layouts: string[] = [];
  // 检测常见布局元素
  if (/<p:sp.*<p:txBody/.test(xml)) layouts.push("textBox");
  if (/<p:graphicFrame/.test(xml)) layouts.push("table");
  if (/<p:pic/.test(xml)) layouts.push("image");
  if (/<p:chart/.test(xml)) layouts.push("chart");
  if (/<p:cxnSp/.test(xml)) layouts.push("shape");
  if (/<p:grpSp/.test(xml)) layouts.push("group");
  return layouts;
}

/** 将 spec 对象序列化为 YAML（简易实现） */
function specToYaml(spec: any, indent: number = 0): string {
  const prefix = "  ".repeat(indent);
  if (spec === null || spec === undefined) return "null";
  if (typeof spec === "string") return `"${spec.replace(/"/g, '\\"')}"`;
  if (typeof spec === "number" || typeof spec === "boolean") return String(spec);

  if (Array.isArray(spec)) {
    if (spec.length === 0) return "[]";
    return "\n" + spec.map(item => `${prefix}- ${specToYaml(item, indent + 1)}`).join("\n");
  }

  if (typeof spec === "object") {
    const entries = Object.entries(spec).filter(([, v]) => v !== undefined && v !== "");
    if (entries.length === 0) return "{}";
    return (
      "\n" +
      entries
        .map(([key, value]) => {
          const val = specToYaml(value, indent + 1);
          return val.startsWith("\n")
            ? `${prefix}${key}:${val}`
            : `${prefix}${key}: ${val}`;
        })
        .join("\n")
    );
  }

  return String(spec);
}

// ── PPTX 样式提取 ──
async function extractPptxStyle(unpackedDir: string, sourceName: string) {
  const presXmlPath = join(unpackedDir, "ppt/presentation.xml");

  // 获取幻灯片尺寸
  let slideWidth = 12192000;  // 默认 16:9 宽度 (EMU)
  let slideHeight = 6858000;  // 默认 16:9 高度 (EMU)

  if (existsSync(presXmlPath)) {
    const presXml = await readFile(presXmlPath, "utf-8");
    const cxMatch = presXml.match(/cx="(\d+)"/);
    const cyMatch = presXml.match(/cy="(\d+)"/);
    if (cxMatch) slideWidth = parseInt(cxMatch[1], 10);
    if (cyMatch) slideHeight = parseInt(cyMatch[1], 10);
  }

  const colorMap = new Map<string, number>();
  const fontMap = new Map<string, { count: number; sizes: number[]; bold: boolean }>();
  const layoutPatterns: string[] = [];
  let slideCount = 0;

  // 扫描所有幻灯片
  const slidesDir = join(unpackedDir, "ppt/slides");
  if (existsSync(slidesDir)) {
    const { readdirSync } = await import("fs");
    const slideFiles = readdirSync(slidesDir)
      .filter(f => /^slide\d+\.xml$/.test(f))
      .sort();

    slideCount = slideFiles.length;

    for (const file of slideFiles) {
      const xml = await readFile(join(slidesDir, file), "utf-8");

      // 提取颜色
      const colors = extractColors(xml);
      for (const [color, count] of colors) {
        colorMap.set(color, (colorMap.get(color) || 0) + count);
      }

      // 提取字体
      const fonts = extractFontInfo(xml);
      for (const [name, info] of fonts) {
        const existing = fontMap.get(name) || { count: 0, sizes: [] as number[], bold: false };
        existing.count += info.count;
        existing.sizes.push(...info.sizes);
        if (info.bold) existing.bold = true;
        fontMap.set(name, existing);
      }

      // 提取布局
      layoutPatterns.push(...extractLayouts(xml));
    }
  }

  // 扫描主题
  const themePath = join(unpackedDir, "ppt/theme/theme1.xml");
  let themeName = "Office Theme";
  if (existsSync(themePath)) {
    const themeXml = await readFile(themePath, "utf-8");
    const nameMatch = themeXml.match(/name="([^"]+)"/);
    if (nameMatch) themeName = nameMatch[1];

    const themeColors = extractColors(themeXml);
    for (const [color, count] of themeColors) {
      colorMap.set(color, (colorMap.get(color) || 0) + count);
    }
  }

  // 构建调色板
  const sortedColors = [...colorMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([color, count]) => ({ color, count, usage: "" }));

  const primary = sortedColors[0]?.color || "333333";
  const secondary = sortedColors[1]?.color || "666666";
  const accent = sortedColors[2]?.color || "999999";

  // 构建字体信息
  const sortedFonts = [...fontMap.entries()]
    .sort((a, b) => b[1].count - a[1].count);

  const fonts: any = {};
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

  // 布局模式统计
  const layoutCounts = new Map<string, number>();
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

// ── DOCX 样式提取 ──
async function extractDocxStyle(unpackedDir: string, sourceName: string) {
  const stylesPath = join(unpackedDir, "word/styles.xml");
  const docPath = join(unpackedDir, "word/document.xml");

  let pageSize = "letter";
  let orientation = "portrait";
  let margins = { top_dxa: 1440, bottom_dxa: 1440, left_dxa: 1440, right_dxa: 1440 };

  // 解析页面设置
  if (existsSync(docPath)) {
    const docXml = await readFile(docPath, "utf-8");
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

  // 解析样式
  const styles: Record<string, any> = {};
  if (existsSync(stylesPath)) {
    const stylesXml = await readFile(stylesPath, "utf-8");
    const styleRe = /<w:style\s[^>]*w:styleId="([^"]+)"[^>]*>([\s\S]*?)<\/w:style>/g;
    let match: RegExpExecArray | null;
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
    has_header: existsSync(join(unpackedDir, "word/header1.xml")),
    has_footer: existsSync(join(unpackedDir, "word/footer1.xml")),
  };
}

// ── 工具定义 ──
export const officeExtractStyleTool = {
  name: "office_extract_style",
  description: "TOOL_OFFICE_EXTRACT_STYLE_DESC",
  briefDescription: "TOOL_OFFICE_EXTRACT_STYLE_BRIEF",
  category: "file" as const,
  tier: "ondemand" as const,
  requiresPermission: true,
  isReadOnly: false,
  isDestructive: false,
  isConcurrencySafe: true,
  maxResultSizeChars: 30000,

  inputSchema: z.object({
    file_path: z.string().describe("Office 文件路径（.pptx 或 .docx）"),
    output_path: z.string().optional().describe("输出的 YAML 文件路径（可选）"),
  }),

  async execute(
    { file_path, output_path }: { file_path: string; output_path?: string },
    context: { workdir: string }
  ) {
    try {
      const absFilePath = isAbsolute(file_path) ? file_path : resolve(context.workdir, file_path);
      const absOutputPath = output_path
        ? (isAbsolute(output_path) ? output_path : resolve(context.workdir, output_path))
        : undefined;

      // ── 1. 解压文档（临时） ──
      // 注意：原始代码调用 ed() (unpackOffice) 解压到临时目录
      // 此处简化为直接说明流程
      const { unpackOfficeDocument } = await import("./office_unpack");
      const unpackResult = await unpackOfficeDocument(absFilePath);
      const unpackedDir = unpackResult.outputDir;

      try {
        // ── 2. 根据格式提取样式 ──
        let spec: any;
        const sourceName = basename(absFilePath);

        if (unpackResult.format === "pptx") {
          spec = await extractPptxStyle(unpackedDir, sourceName);
        } else if (unpackResult.format === "docx") {
          spec = await extractDocxStyle(unpackedDir, sourceName);
        } else {
          throw new Error(`不支持从 ${unpackResult.format} 格式提取设计规范，仅支持 .pptx 和 .docx`);
        }

        // ── 3. 写出 YAML ──
        const yamlContent = specToYaml(spec);
        const yamlPath = absOutputPath || absFilePath.replace(/\.\w+$/, ".style.yaml");
        await writeFile(yamlPath, yamlContent, "utf-8");

        // ── 4. 构建返回信息 ──
        const lines = [
          "设计规范提取完成",
          "",
          "| 项目 | 值 |",
          "|------|------|",
          `| 源文件 | ${absFilePath} |`,
          `| 格式 | ${spec.format} |`,
          `| YAML 输出 | ${yamlPath} |`,
        ];

        if (spec.format === "pptx") {
          lines.push(
            `| 幻灯片数 | ${spec.slide_count} |`,
            `| 主题 | ${spec.theme_name} |`,
            `| 主色 | #${spec.color_palette.primary} |`
          );
        }

        lines.push("", "### YAML 内容", "", "```yaml");
        const yamlText = await readFile(yamlPath, "utf-8");
        lines.push(yamlText, "```");

        return { type: "success" as const, content: lines.join("\n") };
      } finally {
        // 清理临时解压目录
        await rm(unpackedDir, { recursive: true, force: true }).catch(() => {});
      }
    } catch (err: any) {
      return { type: "error" as const, error: `提取设计规范失败：${err.message}` };
    }
  },
};
