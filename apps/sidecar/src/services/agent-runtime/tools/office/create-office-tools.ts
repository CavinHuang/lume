import type { ToolDefinition } from "@lume/agent-sdk";
import { basename, resolve as resolvePath } from "node:path";
import { createSdkJsonResultTool } from "../sdk-tool-result";
import { OfficeToolExecutor } from "./office-tool-executor";

export function createSdkOfficeTools(): ToolDefinition[] {
  return [
    createSdkJsonResultTool({
      name: "office_validate",
      description: "校验 Office OOXML 包结构、XML 合法性、schema、redline，以及唯一 ID/关系约束。支持 docx、xlsx、pptx 等 Office 文档。当用户上传了 Office 文件并需要检查文档完整性时，优先使用此工具。",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", minLength: 1 },
          maxEntries: { type: "number", minimum: 1, maximum: 200 },
          original: { type: "string", minLength: 1 },
          autoRepair: { type: "boolean" },
          author: { type: "string", minLength: 1 }
        },
        required: ["path"]
      },
      isReadOnly: true,
      isConcurrencySafe: true,
      async call(args, context) {
        const executor = new OfficeToolExecutor(context.cwd);
        const path = resolveInputPath(requiredString(args.path, "path"), context.cwd);
        const maxEntries = clampNumber(args.maxEntries, 40, 1, 200);
        const original = args.original ? resolveInputPath(requiredString(args.original, "original"), context.cwd) : "";
        const autoRepair = args.autoRepair === true;
        const author = typeof args.author === "string" && args.author.trim().length > 0 ? args.author.trim() : "Claude";
        const result = await executor.runPythonScript("validate.py", [path, "--original", original, "--auto-repair", "--author", author]);
        if (!result.ok) {
          return { ok: false, error: result.stderr ?? result.stdout ?? "office_validate failed" };
        }
        const data = safeParseJson(result.stdout ?? "");
        if (!data || typeof data !== "object") {
          return { ok: false, error: "Invalid office_validate output" };
        }
        const d = data as Record<string, unknown>;
        return {
          ok: d.ok ?? false,
          path,
          kind: d.kind,
          entryCount: d.entryCount,
          entries: sliceArray(d.entries, maxEntries),
          truncated: d.truncated,
          requiredEntries: d.requiredEntries,
          missingRequiredEntries: d.missingRequiredEntries,
          warnings: d.warnings ?? [],
          details: d.details ?? "",
          repairs: d.repairs,
          validation: d.validation,
          original: original || undefined
        };
      }
    }),
    createSdkJsonResultTool({
      name: "office_unpack",
      description: "安全解包 Office OOXML zip 包（docx/xlsx/pptx）到指定目录，以便读取或修改内部 XML 内容。会跳过目录穿越条目，仅支持 store/deflate 条目。当需要读取或分析 xlsx/docx/pptx 文件内部数据时，先用此工具解包，再读取 XML 文件获取数据。典型工作流：office_unpack → 读取/编辑 XML → office_pack。",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", minLength: 1 },
          outputDir: { type: "string", minLength: 1 },
          maxEntries: { type: "number", minimum: 1, maximum: 1000 },
          maxTotalBytes: { type: "number", minimum: 1 }
        },
        required: ["path", "outputDir"]
      },
      async call(args, context) {
        const executor = new OfficeToolExecutor(context.cwd);
        const path = resolveInputPath(requiredString(args.path, "path"), context.cwd);
        const outputDir = resolveInputPath(requiredString(args.outputDir, "outputDir"), context.cwd);
        const maxEntries = clampNumber(args.maxEntries, 1000, 1, 1000);
        const maxTotalBytes = clampNumber(args.maxTotalBytes, 50 * 1024 * 1024, 1, 250 * 1024 * 1024);
        const result = await executor.runPythonScript("unpack.py", [path, outputDir, String(maxEntries), String(maxTotalBytes)]);
        if (!result.ok) {
          return { ok: false, error: result.stderr ?? result.stdout ?? "office_unpack failed" };
        }
        const data = safeParseJson(result.stdout ?? "");
        if (!data) {
          return { ok: false, error: "Invalid office_unpack output" };
        }
        const d = data as Record<string, unknown>;
        return {
          ok: d.ok ?? false,
          path,
          outputDir,
          kind: d.kind,
          entryCount: d.entryCount,
          writtenCount: d.writtenCount,
          writtenFiles: sliceArray(d.writtenFiles, maxEntries),
          skippedUnsafeEntries: sliceArray(d.skippedUnsafeEntries, maxEntries),
          skippedUnsupportedEntries: sliceArray(d.skippedUnsupportedEntries, maxEntries),
          truncated: d.truncated
        };
      }
    }),
    createSdkJsonResultTool({
      name: "office_pack",
      description: "将解包后的 Office OOXML 目录重新打包为 docx/pptx/xlsx 文件，支持原始文件校验。在 office_unpack → 编辑 XML → office_pack 工作流的最后一步使用。",
      inputSchema: {
        type: "object",
        properties: {
          inputDir: { type: "string", minLength: 1 },
          outputPath: { type: "string", minLength: 1 },
          maxEntries: { type: "number", minimum: 1, maximum: 1000 },
          maxTotalBytes: { type: "number", minimum: 1 },
          original: { type: "string", minLength: 1 },
          skipValidate: { type: "boolean" }
        },
        required: ["inputDir", "outputPath"]
      },
      async call(args, context) {
        const executor = new OfficeToolExecutor(context.cwd);
        const inputDir = resolveInputPath(requiredString(args.inputDir, "inputDir"), context.cwd);
        const outputPath = resolveInputPath(requiredString(args.outputPath, "outputPath"), context.cwd);
        const maxEntries = clampNumber(args.maxEntries, 1000, 1, 1000);
        const maxTotalBytes = clampNumber(args.maxTotalBytes, 50 * 1024 * 1024, 1, 250 * 1024 * 1024);
        const original = args.original ? resolveInputPath(requiredString(args.original, "original"), context.cwd) : "";
        const skipValidate = args.skipValidate === true;
        const packArgs = [inputDir, outputPath];
        if (original) packArgs.push("--original-path", original);
        if (skipValidate) packArgs.push("--skip-validate");
        const result = await executor.runPythonScript("pack.py", packArgs);
        if (!result.ok) {
          return { ok: false, error: result.stderr ?? result.stdout ?? "office_pack failed" };
        }
        const data = safeParseJson(result.stdout ?? "");
        if (!data || typeof data !== "object") {
          return { ok: false, error: "Invalid office_pack output" };
        }
        const d = data as Record<string, unknown>;
        return {
          ok: d.ok ?? false,
          inputDir,
          outputPath,
          kind: d.kind,
          entryCount: d.entryCount,
          entries: sliceArray(d.entries, maxEntries),
          repairs: d.repairs,
          validationPassed: d.validationPassed,
          original: original || undefined
        };
      }
    }),
    createSdkJsonResultTool({
      name: "office_clean",
      description: "清理 Office 文档中的孤立资源（例如 PPTX 中未引用的媒体、notes、rels）。适用于文档体积优化和冗余清理。",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", minLength: 1 },
          outputPath: { type: "string", minLength: 1 }
        },
        required: ["path"]
      },
      async call(args, context) {
        const executor = new OfficeToolExecutor(context.cwd);
        const path = resolveInputPath(requiredString(args.path, "path"), context.cwd);
        const outputPath = args.outputPath ? resolveInputPath(requiredString(args.outputPath, "outputPath"), context.cwd) : addSuffix(path, ".clean");
        const result = await executor.runPythonScript("clean.py", [path, outputPath]);
        if (!result.ok) {
          return { ok: false, error: result.stderr ?? result.stdout ?? "office_clean failed" };
        }
        const data = safeParseJson(result.stdout ?? "");
        if (!data) {
          return { ok: false, error: "Invalid office_clean output" };
        }
        const d = data as Record<string, unknown>;
        return {
          ok: d.ok ?? false,
          path,
          outputPath,
          removed: d.removed,
          warnings: d.warnings
        };
      }
    }),
    createSdkJsonResultTool({
      name: "office_convert",
      description: "Office 文档格式转换（基于 LibreOffice headless）。支持 docx/xlsx/pptx/pdf 等格式互转，例如 xlsx→pdf、docx→pdf、pptx→pdf 等。当用户需要将 xlsx/docx/pptx 转换为其他格式时使用。target 参数指定目标格式，如 pdf、csv、html 等。",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", minLength: 1 },
          outputDir: { type: "string", minLength: 1 },
          target: { type: "string", minLength: 1 }
        },
        required: ["path", "target"]
      },
      async call(args, context) {
        const executor = new OfficeToolExecutor(context.cwd);
        const path = resolveInputPath(requiredString(args.path, "path"), context.cwd);
        const target = requiredString(args.target, "target");
        const outputDir = args.outputDir ? resolveInputPath(requiredString(args.outputDir, "outputDir"), context.cwd) : context.cwd;
        const result = await executor.convertWithSoffice(path, outputDir, target);
        if (!result.ok) {
          return { ok: false, error: result.stderr ?? "office_convert failed" };
        }
        const outputPath = resolvePath(outputDir, `${basename(path).split('.').shift()}.${target}`);
        return {
          ok: true,
          path,
          outputDir,
          target,
          outputPath,
          exitCode: result.exitCode
        };
      }
    }),
    createSdkJsonResultTool({
      name: "docx_create",
      description: "使用 docx 库的 JavaScript 代码创建或生成 Word 文档。传入 JS 代码（code 参数）来定义文档内容和样式，输出 .docx 文件。当需要根据数据或模板生成 Word 文档时使用此工具，不要用 bash 执行 Python。",
      inputSchema: {
        type: "object",
        properties: {
          code: { type: "string", minLength: 1 },
          code_file: { type: "string", minLength: 1 },
          output_path: { type: "string", minLength: 1 }
        },
        required: ["output_path"]
      },
      async call(args, context) {
        const executor = new OfficeToolExecutor(context.cwd);
        const outputPath = resolveInputPath(requiredString(args.output_path, "output_path"), context.cwd);
        if (args.code && args.code_file) {
          return { ok: false, error: "code 与 code_file 只能二选一" };
        }
        if (!args.code && !args.code_file) {
          return { ok: false, error: "请提供 code 或 code_file 参数（二选一）" };
        }
        const codeFile = typeof args.code_file === "string" ? args.code_file : undefined;
        const userCode = codeFile
          ? readFileIfExists(resolveInputPath(codeFile, context.cwd))
          : typeof args.code === "string" ? args.code : null;
        if (!userCode) {
          return { ok: false, error: "未找到代码内容" };
        }
        const codeFileBasename = codeFile ? basename(codeFile) : undefined;
        const result = await executor.executeJs(userCode, outputPath);
        if (!result.ok) {
          return { ok: false, error: result.stderr ?? result.stdout ?? "docx_create failed", code_file: codeFileBasename };
        }
        return {
          ok: true,
          output_path: outputPath,
          code_file: codeFileBasename,
          message: result.stdout?.trim() || "DOCX 创建完成"
        };
      }
    }),
    createSdkJsonResultTool({
      name: "pptx_create",
      description: "使用 PptxGenJS 库的 JavaScript 代码创建 PowerPoint 文档。传入 JS 代码（code 参数）来定义幻灯片内容和布局，输出 .pptx 文件。当需要根据数据或模板生成 PPT 时使用此工具，不要用 bash 执行 Python。",
      inputSchema: {
        type: "object",
        properties: {
          code: { type: "string", minLength: 1 },
          code_file: { type: "string", minLength: 1 },
          output_path: { type: "string", minLength: 1 }
        },
        required: ["output_path"]
      },
      async call(args, context) {
        const executor = new OfficeToolExecutor(context.cwd);
        const outputPath = resolveInputPath(requiredString(args.output_path, "output_path"), context.cwd);
        if (args.code && args.code_file) {
          return { ok: false, error: "code 与 code_file 只能二选一" };
        }
        if (!args.code && !args.code_file) {
          return { ok: false, error: "请提供 code 或 code_file 参数（二选一）" };
        }
        const codeFile = typeof args.code_file === "string" ? args.code_file : undefined;
        const userCode = codeFile
          ? readFileIfExists(resolveInputPath(codeFile, context.cwd))
          : typeof args.code === "string" ? args.code : null;
        if (!userCode) {
          return { ok: false, error: "未找到代码内容" };
        }
        const codeFileBasename = codeFile ? basename(codeFile) : undefined;
        const result = await executor.executeJs(userCode, outputPath);
        if (!result.ok) {
          return { ok: false, error: result.stderr ?? result.stdout ?? "pptx_create failed", code_file: codeFileBasename };
        }
        return {
          ok: true,
          output_path: outputPath,
          code_file: codeFileBasename,
          message: result.stdout?.trim() || "PPTX 创建完成"
        };
      }
    }),
    createSdkJsonResultTool({
      name: "xlsx_create",
      description: "使用 openpyxl 执行 Python 代码来读取、分析、创建或修改 Excel 文档。传入 Python 代码（code 参数），可使用 openpyxl 操作工作簿。\n\n典型用法：\n- 读取数据：openpyxl.load_workbook(\"文件.xlsx\") → 遍历单元格，print() 输出结果\n- 分析统计：读取后计算汇总、筛选、排序等，print() 输出\n- 创建文档：openpyxl.Workbook() → 添加数据 → wb.save(output_path)\n- 修改文档：load_workbook → 修改单元格 → save(output_path)\n\n当用户上传了 xlsx 文件需要读取数据、分析统计、修改内容时，优先使用此工具而非 bash 执行 Python。代码中通过 sys.argv[1] 获取 output_path（仅写文件时需要）。",
      inputSchema: {
        type: "object",
        properties: {
          code: { type: "string", minLength: 1 },
          code_file: { type: "string", minLength: 1 },
          output_path: { type: "string", minLength: 1 }
        },
        required: []
      },
      async call(args, context) {
        const executor = new OfficeToolExecutor(context.cwd);
        const hasOutput = typeof args.output_path === "string" && args.output_path.trim().length > 0;
        const outputPath = hasOutput ? resolveInputPath(args.output_path as string, context.cwd) : "";
        if (args.code && args.code_file) {
          return { ok: false, error: "code 与 code_file 只能二选一" };
        }
        if (!args.code && !args.code_file) {
          return { ok: false, error: "请提供 code 或 code_file 参数（二选一）" };
        }
        const codeFile = typeof args.code_file === "string" ? args.code_file : undefined;
        const userCode = codeFile
          ? readFileIfExists(resolveInputPath(codeFile, context.cwd))
          : typeof args.code === "string" ? args.code : null;
        if (!userCode) {
          return { ok: false, error: "未找到代码内容" };
        }
        const codeFileBasename = codeFile ? basename(codeFile) : undefined;
        const result = await executor.executePython(`
import sys
output_path = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] else None
${userCode}
`, hasOutput ? [outputPath] : []);
        if (!result.ok) {
          return { ok: false, error: result.stderr ?? result.stdout ?? "xlsx_create failed", code_file: codeFileBasename };
        }
        return {
          ok: true,
          output_path: hasOutput ? outputPath : undefined,
          code_file: codeFileBasename,
          message: result.stdout?.trim() || (hasOutput ? "Excel 创建完成" : "执行完成")
        };
      }
    }),
    createSdkJsonResultTool({
      name: "pdf_create",
      description: "使用 reportlab 的 Python 代码创建 PDF 文档。传入 Python 代码（code 参数）来定义 PDF 内容和布局，输出 .pdf 文件。当需要生成 PDF 报告或文档时使用此工具，不要用 bash 执行 Python。代码中通过 sys.argv[1] 获取 output_path。",
      inputSchema: {
        type: "object",
        properties: {
          code: { type: "string", minLength: 1 },
          code_file: { type: "string", minLength: 1 },
          output_path: { type: "string", minLength: 1 }
        },
        required: ["output_path"]
      },
      async call(args, context) {
        const executor = new OfficeToolExecutor(context.cwd);
        const outputPath = resolveInputPath(requiredString(args.output_path, "output_path"), context.cwd);
        if (args.code && args.code_file) {
          return { ok: false, error: "code 与 code_file 只能二选一" };
        }
        if (!args.code && !args.code_file) {
          return { ok: false, error: "请提供 code 或 code_file 参数（二选一）" };
        }
        const codeFile = typeof args.code_file === "string" ? args.code_file : undefined;
        const userCode = codeFile
          ? readFileIfExists(resolveInputPath(codeFile, context.cwd))
          : typeof args.code === "string" ? args.code : null;
        if (!userCode) {
          return { ok: false, error: "未找到代码内容" };
        }
        const codeFileBasename = codeFile ? basename(codeFile) : undefined;
        const result = await executor.executePython(`
import sys
output_path = sys.argv[1]
${userCode}
`, [outputPath]);
        if (!result.ok) {
          return { ok: false, error: result.stderr ?? result.stdout ?? "pdf_create failed", code_file: codeFileBasename };
        }
        return {
          ok: true,
          output_path: outputPath,
          code_file: codeFileBasename,
          message: result.stdout?.trim() || "PDF 创建完成"
        };
      }
    }),
    createSdkJsonResultTool({
      name: "docx_comment",
      description: "向 Word 文档（已解包目录）添加批注。需要先用 office_unpack 解包 docx 文件，然后传入解包目录路径。添加批注后用 office_pack 重新打包。",
      inputSchema: {
        type: "object",
        properties: {
          unpacked_dir: { type: "string", minLength: 1 },
          comment_id: { type: "number", minimum: 0 },
          text: { type: "string", minLength: 1 },
          author: { type: "string", minLength: 1 },
          parent_id: { type: "number", minimum: 0 }
        },
        required: ["unpacked_dir", "comment_id", "text"]
      },
      async call(args, context) {
        const executor = new OfficeToolExecutor(context.cwd);
        const unpackedDir = resolveInputPath(requiredString(args.unpacked_dir, "unpacked_dir"), context.cwd);
        const commentId = clampNumber(args.comment_id, 0, 0, Number.MAX_SAFE_INTEGER);
        const text = requiredString(args.text, "text");
        const author = typeof args.author === "string" && args.author.trim().length > 0 ? args.author : "Assistant";
        const parentId = args.parent_id !== undefined ? clampNumber(args.parent_id, 0, 0, Number.MAX_SAFE_INTEGER) : undefined;
        const result = await executor.runPythonScript("comment.py", [unpackedDir, String(commentId), text, author, parentId !== undefined ? String(parentId) : ""]);
        if (!result.ok) {
          return { ok: false, error: result.stderr ?? result.stdout ?? "docx_comment failed" };
        }
        const data = safeParseJson(result.stdout ?? "");
        if (!data) {
          return { ok: false, error: "Invalid docx_comment output" };
        }
        const d = data as Record<string, unknown>;
        return {
          ok: d.ok ?? false,
          unpacked_dir: unpackedDir,
          comment_id: commentId,
          text,
          author,
          parent_id: parentId,
          added: d.added
        };
      }
    }),
    createSdkJsonResultTool({
      name: "pptx_add_slide",
      description: "向 PPTX 文件添加新幻灯片。可以直接操作 pptx 文件，也可以通过解包目录操作后重打包。当需要给演示文稿增加页面时使用。",
      inputSchema: {
        type: "object",
        properties: {
          input_path: { type: "string", minLength: 1 },
          output_path: { type: "string", minLength: 1 },
          slide_xml: { type: "string", minLength: 1 }
        },
        required: ["input_path", "output_path"]
      },
      async call(args, context) {
        const executor = new OfficeToolExecutor(context.cwd);
        const inputPath = resolveInputPath(requiredString(args.input_path, "input_path"), context.cwd);
        const outputPath = resolveInputPath(requiredString(args.output_path, "output_path"), context.cwd);
        const slideXml = typeof args.slide_xml === "string" ? args.slide_xml : "";
        const source = slideXml || "slideLayout1.xml";
        const result = await executor.runJsScript("add_slide.mjs", [inputPath, outputPath, source]);
        if (!result.ok) {
          return { ok: false, error: result.stderr ?? result.stdout ?? "pptx_add_slide failed" };
        }
        const data = safeParseJson(result.stdout ?? "");
        if (!data) {
          return { ok: false, error: "Invalid pptx_add_slide output" };
        }
        const d = data as Record<string, unknown>;
        return {
          ok: d.ok ?? false,
          input_path: inputPath,
          output_path: outputPath,
          added_slide: d.added_slide,
          new_slide_file: d.new_slide_file,
          new_slide_number: d.new_slide_number,
          sld_id: d.sld_id,
          r_id: d.r_id,
          message: d.message
        };
      }
    }),
    createSdkJsonResultTool({
      name: "xlsx_recalc",
      description: "重新计算 Excel 文件中的所有公式并返回错误统计。当 xlsx 文件中包含公式且需要验证公式正确性或刷新计算结果时使用。返回公式总数、错误数和错误摘要。",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", minLength: 1 },
          timeout: { type: "number", minimum: 1 }
        },
        required: ["path"]
      },
      async call(args, context) {
        const executor = new OfficeToolExecutor(context.cwd);
        const path = resolveInputPath(requiredString(args.path, "path"), context.cwd);
        const timeout = clampNumber(args.timeout, 30, 1, 600);
        const result = await executor.runPythonScript("recalc.py", [path, String(timeout)]);
        if (!result.ok) {
          return { ok: false, error: result.stderr ?? result.stdout ?? "xlsx_recalc failed" };
        }
        const data = safeParseJson(result.stdout ?? "");
        if (!data) {
          return { ok: false, error: "Invalid xlsx_recalc output" };
        }
        const d = data as Record<string, unknown>;
        return {
          ok: d.ok ?? false,
          path,
          status: d.status,
          total_formulas: d.total_formulas,
          total_errors: d.total_errors,
          error_summary: d.error_summary
        };
      }
    }),
    createSdkJsonResultTool({
      name: "pdf_tools",
      description: "PDF 文件操作工具集：合并、拆分、旋转、添加水印、加密/解密、提取图片。action 参数指定操作类型，input_paths 指定输入文件，output_path 指定输出路径。当用户需要对 PDF 文件进行处理时使用。",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", minLength: 1 },
          input_paths: { type: "array", items: { type: "string", minLength: 1 } },
          output_path: { type: "string", minLength: 1 },
          options: { type: "object" }
        },
        required: ["action", "input_paths", "output_path"]
      },
      async call(args, context) {
        const executor = new OfficeToolExecutor(context.cwd);
        const action = requiredString(args.action, "action");
        const inputPaths = Array.isArray(args.input_paths) ? args.input_paths.map((value) => resolveInputPath(requiredString(value, "input_paths[]"), context.cwd)) : [];
        const outputPath = resolveInputPath(requiredString(args.output_path, "output_path"), context.cwd);
        if (inputPaths.length === 0) {
          return { ok: false, error: "input_paths 不能为空" };
        }
        const options = (args.options && typeof args.options === "object") ? JSON.stringify(args.options) : "{}";
        const result = await executor.runPythonScript("pdf_tools.py", [action, inputPaths.join("|"), outputPath, options]);
        if (!result.ok) {
          return { ok: false, error: result.stderr ?? result.stdout ?? "pdf_tools failed" };
        }
        const data = safeParseJson(result.stdout ?? "");
        if (!data) {
          return { ok: false, error: "Invalid pdf_tools output" };
        }
        const d = data as Record<string, unknown>;
        return {
          ok: d.ok ?? false,
          action,
          input_paths: inputPaths,
          output_path: outputPath,
          message: d.message
        };
      }
    }),
    createSdkJsonResultTool({
      name: "office_extract_style",
      description: "从 Office 文档（docx/pptx/xlsx）中提取设计样式规范，包括颜色调色板、字体、间距、布局模式等。适用于提取模板样式、分析文档设计风格等场景。",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", minLength: 1 },
          output_path: { type: "string", minLength: 1 }
        },
        required: ["path"]
      },
      async call(args, context) {
        const executor = new OfficeToolExecutor(context.cwd);
        const path = resolveInputPath(requiredString(args.path, "path"), context.cwd);
        const outputPath = args.output_path ? resolveInputPath(requiredString(args.output_path, "output_path"), context.cwd) : addSuffix(path, ".style.yaml");
        const result = await executor.runJsScript("extract_style.mjs", [path, outputPath]);
        if (!result.ok) {
          return { ok: false, error: result.stderr ?? result.stdout ?? "office_extract_style failed" };
        }
        const data = safeParseJson(result.stdout ?? "");
        if (!data) {
          return { ok: false, error: "Invalid office_extract_style output" };
        }
        const d = data as Record<string, unknown>;
        return {
          ok: d.ok ?? false,
          path: d.path ?? path,
          output_path: d.output_path ?? outputPath,
          format: d.format,
          source: d.source,
          slide_size: d.slide_size,
          color_palette: d.color_palette,
          fonts: d.fonts,
          spacing: d.spacing,
          layout_patterns: d.layout_patterns,
          theme_name: d.theme_name,
          slide_count: d.slide_count,
          page: d.page,
          styles: d.styles,
          has_header: d.has_header,
          has_footer: d.has_footer,
        };
      }
    }),
    createSdkJsonResultTool({
      name: "office_accept_changes",
      description: "接受 Word 文档中的所有修订（Tracked Changes），生成一个干净的文档。当 docx 文件包含修订标记需要批量接受时使用。",
      inputSchema: {
        type: "object",
        properties: {
          input_path: { type: "string", minLength: 1 },
          output_path: { type: "string", minLength: 1 }
        },
        required: ["input_path", "output_path"]
      },
      async call(args, context) {
        const executor = new OfficeToolExecutor(context.cwd);
        const inputPath = resolveInputPath(requiredString(args.input_path, "input_path"), context.cwd);
        const outputPath = resolveInputPath(requiredString(args.output_path, "output_path"), context.cwd);
        const result = await executor.runPythonScript("accept_changes.py", [inputPath, outputPath]);
        if (!result.ok) {
          return { ok: false, error: result.stderr ?? result.stdout ?? "office_accept_changes failed" };
        }
        const data = safeParseJson(result.stdout ?? "");
        if (!data) {
          return { ok: false, error: "Invalid office_accept_changes output" };
        }
        const d = data as Record<string, unknown>;
        return {
          ok: d.ok ?? false,
          input_path: inputPath,
          output_path: outputPath,
          message: d.message
        };
      }
    }),
    createSdkJsonResultTool({
      name: "info_extract",
      description: "从文档（docx/xlsx/pptx/pdf 等）中提取关键信息。支持合同、报告、简历等多种文档类型的信息提取，自动分配信息提取专家并分步骤执行。extraction_type 参数可选 contract（合同）、resume（简历）、report（报告）等。当用户上传文档并需要从中提取结构化信息时使用。",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", minLength: 1, description: "要提取信息的文档路径" },
          extraction_type: { type: "string", description: "提取类型：contract（合同）、resume（简历）、report（报告）等" }
        },
        required: ["path"]
      },
      async call(args, context) {
        const executor = new OfficeToolExecutor(context.cwd);
        const path = resolveInputPath(requiredString(args.path, "path"), context.cwd);
        const extractionType = (args.extraction_type as string) || "contract";
        const result = await executor.runPythonScript("info_extract.py", [path, extractionType]);
        if (!result.ok) {
          return { ok: false, error: result.stderr ?? result.stdout ?? "info_extract failed" };
        }
        const data = safeParseJson(result.stdout ?? "");
        if (!data || typeof data !== "object") {
          return { ok: false, error: "Invalid info_extract output" };
        }
        const d = data as Record<string, unknown>;
        return {
          ok: d.ok ?? false,
          path,
          extraction_type: extractionType,
          expert: d.expert,
          configConfirmed: d.configConfirmed ?? true,
          steps: d.steps
        };
      }
    }),
    createSdkJsonResultTool({
      name: "office_thumbnail",
      description: "为 PowerPoint 文件生成缩略图网格预览。将 PPT 每页幻灯片渲染为图片并拼成网格。当用户需要预览 PPT 内容或生成 PPT 封面图时使用。",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", minLength: 1 },
          output_prefix: { type: "string", minLength: 1 },
          cols: { type: "number", minimum: 1, maximum: 12 }
        },
        required: ["path"]
      },
      async call(args, context) {
        const executor = new OfficeToolExecutor(context.cwd);
        const path = resolveInputPath(requiredString(args.path, "path"), context.cwd);
        const outputPrefix = args.output_prefix ? resolveInputPath(requiredString(args.output_prefix, "output_prefix"), context.cwd) : resolvePath(context.cwd, "thumbnails");
        const cols = clampNumber(args.cols, 3, 1, 12);
        const result = await executor.runPythonScript("thumbnail.py", [path, outputPrefix, String(cols)]);
        if (!result.ok) {
          return { ok: false, error: result.stderr ?? result.stdout ?? "office_thumbnail failed" };
        }
        const data = safeParseJson(result.stdout ?? "");
        if (!data) {
          return { ok: false, error: "Invalid office_thumbnail output" };
        }
        const d = data as Record<string, unknown>;
        return {
          ok: d.ok ?? false,
          path,
          output_prefix: outputPrefix,
          outputs: d.outputs
        };
      }
    })
  ];
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function resolveInputPath(path: string, cwd: string): string {
  if (isAbsolute(path)) {
    return path;
  }
  return resolvePath(cwd, path);
}

function isAbsolute(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[/\\]/.test(path);
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const valueNumber = Math.floor(value);
  return Math.max(min, Math.min(max, valueNumber));
}

function sliceArray<T>(value: unknown, maxLength: number): T[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.slice(0, Math.max(1, maxLength));
}

function safeParseJson(payload: string): unknown {
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function addSuffix(filePath: string, suffix: string): string {
  const path = resolvePath(filePath);
  if (path.endsWith(suffix)) {
    return path;
  }
  return `${path}${suffix}`;
}

function readFileIfExists(filePath: string): string | null {
  try {
    const { readFileSync } = require("node:fs");
    return readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}
