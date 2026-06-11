/**
 * pptx_add_slide - 向已解压的 PPTX 目录添加幻灯片
 *
 * Tier: ondemand | Category: file
 * 操作对象: office_unpack 解压后的 PPTX XML 目录
 */

import { z } from "zod";
import { resolve, isAbsolute, join } from "path";
import { readFile, writeFile, readdir, copyFile, existsSync } from "fs/promises";

export const pptxAddSlideTool = {
  name: "pptx_add_slide",
  briefDescription: "TOOL_PPTX_ADD_SLIDE_BRIEF",
  description: "TOOL_PPTX_ADD_SLIDE_DESC",
  category: "file" as const,
  tier: "ondemand" as const,
  requiresPermission: true,
  isReadOnly: false,
  isDestructive: false,
  isConcurrencySafe: false,
  maxResultSizeChars: 5000,

  inputSchema: z.object({
    dir_path: z.string().describe("已解压的 PPTX 目录路径"),
    source: z.string().describe("幻灯片来源：'slideN.xml' 复制现有幻灯片，或 'slideLayoutN.xml' 基于布局创建空白幻灯片"),
  }),

  async execute(
    { dir_path, source }: { dir_path: string; source: string },
    context: { workdir: string }
  ) {
    try {
      const absDirPath = isAbsolute(dir_path) ? dir_path : resolve(context.workdir, dir_path);
      const result = await addSlideToPptx(absDirPath, source);

      return {
        type: "success" as const,
        content: [
          "幻灯片添加成功",
          "",
          "| 项目 | 值 |",
          "|------|------|",
          `| 新幻灯片文件 | ${result.newSlideFile} |`,
          `| 幻灯片编号 | ${result.newSlideNumber} |`,
          `| sldId | ${result.nextSldId} |`,
          "",
          "需要在 ppt/presentation.xml 的 <p:sldIdLst> 中插入以下 XML：",
          "```xml",
          result.sldIdXml,
          "```",
        ].join("\n"),
      };
    } catch (err: any) {
      return { type: "error" as const, error: `添加幻灯片失败：${err.message}` };
    }
  },
};

// ============================================================
// 核心实现
// ============================================================
async function addSlideToPptx(dirPath: string, source: string) {
  // ── 1. 确定新幻灯片编号 ──
  const nextSlideNum = await getNextSlideNumber(dirPath);
  const slideFileName = `slide${nextSlideNum}.xml`;
  const slidePath = join(dirPath, "ppt/slides", slideFileName);
  const relsDir = join(dirPath, "ppt/slides/_rels");
  const relsPath = join(relsDir, `${slideFileName}.rels`);

  // ── 2. 根据来源类型创建幻灯片 ──
  if (source.startsWith("slide") && source.endsWith(".xml") && !source.includes("Layout")) {
    // 复制现有幻灯片
    const srcPath = join(dirPath, "ppt/slides", source);
    if (!existsSync(srcPath)) throw new Error(`源幻灯片不存在：${source}`);
    await copyFile(srcPath, slidePath);

    // 复制关系文件（去掉 notesSlide 引用）
    const srcRels = join(dirPath, "ppt/slides/_rels", `${source}.rels`);
    if (existsSync(srcRels)) {
      let relsContent = await readFile(srcRels, "utf-8");
      relsContent = relsContent.replace(
        /<Relationship[^>]*Type="[^"]*notesSlide[^"]*"[^>]*\/>/g, ""
      );
      await writeFile(relsPath, relsContent, "utf-8");
    }
  } else if (source.includes("Layout")) {
    // 基于 slideLayout 创建空白幻灯片
    const layoutNum = source.match(/(\d+)/)?.[1] || "1";
    const layoutRef = `../slideLayouts/slideLayout${layoutNum}.xml`;

    // 空白幻灯片 XML
    await writeFile(slidePath, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
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
</p:sld>`, "utf-8");

    // 关系文件
    await writeFile(relsPath, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="${layoutRef}"/>
</Relationships>`, "utf-8");
  } else {
    throw new Error(`无效的 source 参数："${source}"。应为 slideN.xml 或 slideLayoutN.xml`);
  }

  // ── 3. 更新 [Content_Types].xml ──
  const contentTypesPath = join(dirPath, "[Content_Types].xml");
  if (existsSync(contentTypesPath)) {
    let ct = await readFile(contentTypesPath, "utf-8");
    const override = `<Override PartName="/ppt/slides/${slideFileName}" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`;
    if (!ct.includes(`/ppt/slides/${slideFileName}`)) {
      ct = ct.replace("</Types>", `  ${override}\n</Types>`);
      await writeFile(contentTypesPath, ct, "utf-8");
    }
  }

  // ── 4. 更新 presentation.xml.rels ──
  const presRelsPath = join(dirPath, "ppt/_rels/presentation.xml.rels");
  let rId = "rId100";
  if (existsSync(presRelsPath)) {
    let rels = await readFile(presRelsPath, "utf-8");
    rId = await getNextRId(rels);
    const newRel = `<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/${slideFileName}"/>`;
    if (!rels.includes(`slides/${slideFileName}`)) {
      rels = rels.replace("</Relationships>", `  ${newRel}\n</Relationships>`);
      await writeFile(presRelsPath, rels, "utf-8");
    }
  }

  // ── 5. 计算 sldId ──
  const presPath = join(dirPath, "ppt/presentation.xml");
  let sldId = 256;
  if (existsSync(presPath)) {
    const pres = await readFile(presPath, "utf-8");
    sldId = await getNextSldId(pres);
  }

  return {
    newSlideFile: slideFileName,
    newSlideNumber: nextSlideNum,
    sldIdXml: `<p:sldId id="${sldId}" r:id="${rId}"/>`,
    nextSldId: sldId,
  };
}

/** 扫描 slides 目录获取下一个幻灯片编号 */
async function getNextSlideNumber(dirPath: string): Promise<number> {
  const slidesDir = join(dirPath, "ppt/slides");
  try {
    const files = await readdir(slidesDir);
    const nums = files
      .filter(f => /^slide\d+\.xml$/.test(f))
      .map(f => parseInt(f.match(/slide(\d+)\.xml/)![1], 10));
    return nums.length > 0 ? Math.max(...nums) + 1 : 1;
  } catch {
    return 1;
  }
}

/** 从 rels XML 中获取下一个 rId */
async function getNextRId(relsXml: string): Promise<string> {
  const re = /Id="rId(\d+)"/g;
  let match: RegExpExecArray | null;
  let max = 0;
  while ((match = re.exec(relsXml)) !== null) {
    const num = parseInt(match[1], 10);
    if (num > max) max = num;
  }
  return `rId${max + 1}`;
}

/** 从 presentation.xml 中获取下一个 sldId */
async function getNextSldId(presXml: string): Promise<number> {
  const re = /id="(\d+)"/g;
  let match: RegExpExecArray | null;
  let max = 255;
  while ((match = re.exec(presXml)) !== null) {
    const num = parseInt(match[1], 10);
    if (num > max) max = num;
  }
  return max + 1;
}
