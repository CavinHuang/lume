import type { ToolDefinition } from "@lume/agent-sdk";
import { basename, resolve as resolvePath } from "node:path";
import { createSdkJsonResultTool } from "../sdk-tool-result";
import { OfficeToolExecutor } from "./office-tool-executor";

export function createSdkOfficeTools(): ToolDefinition[] {
  const executor = new OfficeToolExecutor();
  return [
    createSdkJsonResultTool({
      name: "office_validate",
      description: "校验 Office OOXML 包结构、XML 合法性、schema、redline，以及唯一 ID/关系约束。",
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
        const path = resolveInputPath(requiredString(args.path, "path"), context.cwd);
        const maxEntries = clampNumber(args.maxEntries, 40, 1, 200);
        const original = args.original ? resolveInputPath(requiredString(args.original, "original"), context.cwd) : "";
        const autoRepair = args.autoRepair === true;
        const author = typeof args.author === "string" && args.author.trim().length > 0 ? args.author.trim() : "Claude";
        const result = await executor.runPythonScript("validate.py", [path, "--original", original, "--auto-repair", "--author", author]);
        if (!result.ok) {
          return { ok: false, error: result.stderr ?? result.stdout ?? "office_validate failed" };
        }
        const data = safeParseJson(result.stdout);
        if (!data || typeof data !== "object") {
          return { ok: false, error: "Invalid office_validate output" };
        }
        return {
          ok: data.ok ?? false,
          path,
          kind: data.kind,
          entryCount: data.entryCount,
          entries: sliceArray(data.entries, maxEntries),
          truncated: data.truncated,
          requiredEntries: data.requiredEntries,
          missingRequiredEntries: data.missingRequiredEntries,
          warnings: data.warnings ?? [],
          details: data.details ?? "",
          repairs: data.repairs,
          validation: data.validation,
          original: original || undefined
        };
      }
    }),
    createSdkJsonResultTool({
      name: "office_unpack",
      description: "安全解包 Office OOXML zip 包到指定目录。会跳过目录穿越条目，仅支持 store/deflate 条目。",
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
        const path = resolveInputPath(requiredString(args.path, "path"), context.cwd);
        const outputDir = resolveInputPath(requiredString(args.outputDir, "outputDir"), context.cwd);
        const maxEntries = clampNumber(args.maxEntries, 1000, 1, 1000);
        const maxTotalBytes = clampNumber(args.maxTotalBytes, 50 * 1024 * 1024, 1, 250 * 1024 * 1024);
        const result = await executor.runPythonScript("unpack.py", [path, outputDir, String(maxEntries), String(maxTotalBytes)]);
        if (!result.ok) {
          return { ok: false, error: result.stderr ?? result.stdout ?? "office_unpack failed" };
        }
        const data = safeParseJson(result.stdout);
        if (!data) {
          return { ok: false, error: "Invalid office_unpack output" };
        }
        return {
          ok: data.ok ?? false,
          path,
          outputDir,
          kind: data.kind,
          entryCount: data.entryCount,
          writtenCount: data.writtenCount,
          writtenFiles: sliceArray(data.writtenFiles, maxEntries),
          skippedUnsafeEntries: sliceArray(data.skippedUnsafeEntries, maxEntries),
          skippedUnsupportedEntries: sliceArray(data.skippedUnsupportedEntries, maxEntries),
          truncated: data.truncated
        };
      }
    }),
    createSdkJsonResultTool({
      name: "office_pack",
      description: "将解包后的 Office OOXML 目录重新打包为 docx/pptx/xlsx，支持原始文件校验。",
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
        const data = safeParseJson(result.stdout);
        if (!data || typeof data !== "object") {
          return { ok: false, error: "Invalid office_pack output" };
        }
        return {
          ok: data.ok ?? false,
          inputDir,
          outputPath,
          kind: data.kind,
          entryCount: data.entryCount,
          entries: sliceArray(data.entries, maxEntries),
          repairs: data.repairs,
          validationPassed: data.validationPassed,
          original: original || undefined
        };
      }
    }),
    createSdkJsonResultTool({
      name: "office_clean",
      description: "清理 Office 文档中的孤立资源（例如 PPTX 中未引用的媒体、notes、rels）。",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", minLength: 1 },
          outputPath: { type: "string", minLength: 1 }
        },
        required: ["path"]
      },
      async call(args, context) {
        const path = resolveInputPath(requiredString(args.path, "path"), context.cwd);
        const outputPath = args.outputPath ? resolveInputPath(requiredString(args.outputPath, "outputPath"), context.cwd) : addSuffix(path, ".clean");
        const result = await executor.runPythonScript("clean.py", [path, outputPath]);
        if (!result.ok) {
          return { ok: false, error: result.stderr ?? result.stdout ?? "office_clean failed" };
        }
        const data = safeParseJson(result.stdout);
        if (!data) {
          return { ok: false, error: "Invalid office_clean output" };
        }
        return {
          ok: data.ok ?? false,
          path,
          outputPath,
          removed: data.removed,
          warnings: data.warnings
        };
      }
    }),
    createSdkJsonResultTool({
      name: "office_convert",
      description: "Office 格式转换（LibreOffice headless）。",
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
      description: "使用 docx 库的 JS 代码创建 Word 文档。",
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
        const outputPath = resolveInputPath(requiredString(args.output_path, "output_path"), context.cwd);
        if (args.code && args.code_file) {
          return { ok: false, error: "code 与 code_file 只能二选一" };
        }
        if (!args.code && !args.code_file) {
          return { ok: false, error: "请提供 code 或 code_file 参数（二选一）" };
        }
        const userCode = args.code_file
          ? readFileIfExists(resolveInputPath(args.code_file, context.cwd))
          : args.code;
        if (!userCode) {
          return { ok: false, error: "未找到代码内容" };
        }
        const codeFileBasename = args.code_file ? Path.basename(args.code_file) : undefined;
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
      description: "使用 PptxGenJS 创建 PPTX 文档。",
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
        const outputPath = resolveInputPath(requiredString(args.output_path, "output_path"), context.cwd);
        if (args.code && args.code_file) {
          return { ok: false, error: "code 与 code_file 只能二选一" };
        }
        if (!args.code && !args.code_file) {
          return { ok: false, error: "请提供 code 或 code_file 参数（二选一）" };
        }
        const userCode = args.code_file
          ? readFileIfExists(resolveInputPath(args.code_file, context.cwd))
          : args.code;
        if (!userCode) {
          return { ok: false, error: "未找到代码内容" };
        }
        const codeFileBasename = args.code_file ? Path.basename(args.code_file) : undefined;
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
      description: "使用 openpyxl 创建 Excel 文档。",
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
        const outputPath = resolveInputPath(requiredString(args.output_path, "output_path"), context.cwd);
        if (args.code && args.code_file) {
          return { ok: false, error: "code 与 code_file 只能二选一" };
        }
        if (!args.code && !args.code_file) {
          return { ok: false, error: "请提供 code 或 code_file 参数（二选一）" };
        }
        const userCode = args.code_file
          ? readFileIfExists(resolveInputPath(args.code_file, context.cwd))
          : args.code;
        if (!userCode) {
          return { ok: false, error: "未找到代码内容" };
        }
        const codeFileBasename = args.code_file ? Path.basename(args.code_file) : undefined;
        const result = await executor.executePython(`
import sys
output_path = sys.argv[1]
${userCode}
`, [outputPath]);
        if (!result.ok) {
          return { ok: false, error: result.stderr ?? result.stdout ?? "xlsx_create failed", code_file: codeFileBasename };
        }
        return {
          ok: true,
          output_path: outputPath,
          code_file: codeFileBasename,
          message: result.stdout?.trim() || "Excel 创建完成"
        };
      }
    }),
    createSdkJsonResultTool({
      name: "pdf_create",
      description: "使用 reportlab 创建 PDF 文档。",
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
        const outputPath = resolveInputPath(requiredString(args.output_path, "output_path"), context.cwd);
        if (args.code && args.code_file) {
          return { ok: false, error: "code 与 code_file 只能二选一" };
        }
        if (!args.code && !args.code_file) {
          return { ok: false, error: "请提供 code 或 code_file 参数（二选一）" };
        }
        const userCode = args.code_file
          ? readFileIfExists(resolveInputPath(args.code_file, context.cwd))
          : args.code;
        if (!userCode) {
          return { ok: false, error: "未找到代码内容" };
        }
        const codeFileBasename = args.code_file ? Path.basename(args.code_file) : undefined;
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
      description: "向 Word 文档添加批注。",
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
        const unpackedDir = resolveInputPath(requiredString(args.unpacked_dir, "unpacked_dir"), context.cwd);
        const commentId = clampNumber(args.comment_id, 0, 0, Number.MAX_SAFE_INTEGER);
        const text = requiredString(args.text, "text");
        const author = requiredString(args.author, "author") || "Assistant";
        const parentId = args.parent_id !== undefined ? clampNumber(args.parent_id, 0, 0, Number.MAX_SAFE_INTEGER) : undefined;
        const result = await executor.runPythonScript("comment.py", [unpackedDir, String(commentId), text, author, parentId !== undefined ? String(parentId) : ""]);
        if (!result.ok) {
          return { ok: false, error: result.stderr ?? result.stdout ?? "docx_comment failed" };
        }
        const data = safeParseJson(result.stdout);
        if (!data) {
          return { ok: false, error: "Invalid docx_comment output" };
        }
        return {
          ok: data.ok ?? false,
          unpacked_dir: unpackedDir,
          comment_id: commentId,
          text,
          author,
          parent_id: parentId,
          added: data.added
        };
      }
    }),
    createSdkJsonResultTool({
      name: "pptx_add_slide",
      description: "向 PPTX 添加幻灯片（通过编辑解包目录后重打包）。",
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
        const inputPath = resolveInputPath(requiredString(args.input_path, "input_path"), context.cwd);
        const outputPath = resolveInputPath(requiredString(args.output_path, "output_path"), context.cwd);
        const slideXml = args.slide_xml ?? "";
        const source = slideXml || "slideLayout1.xml";
        const result = await executor.runJsScript("add_slide.mjs", [inputPath, outputPath, source]);
        if (!result.ok) {
          return { ok: false, error: result.stderr ?? result.stdout ?? "pptx_add_slide failed" };
        }
        const data = safeParseJson(result.stdout);
        if (!data) {
          return { ok: false, error: "Invalid pptx_add_slide output" };
        }
        return {
          ok: data.ok ?? false,
          input_path: inputPath,
          output_path: outputPath,
          added_slide: data.added_slide,
          new_slide_file: data.new_slide_file,
          new_slide_number: data.new_slide_number,
          sld_id: data.sld_id,
          r_id: data.r_id,
          message: data.message
        };
      }
    }),
    createSdkJsonResultTool({
      name: "xlsx_recalc",
      description: "重新计算 Excel 公式并返回错误统计。",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", minLength: 1 },
          timeout: { type: "number", minimum: 1 }
        },
        required: ["path"]
      },
      async call(args, context) {
        const path = resolveInputPath(requiredString(args.path, "path"), context.cwd);
        const timeout = clampNumber(args.timeout, 30, 1, 600);
        const result = await executor.runPythonScript("recalc.py", [path, String(timeout)]);
        if (!result.ok) {
          return { ok: false, error: result.stderr ?? result.stdout ?? "xlsx_recalc failed" };
        }
        const data = safeParseJson(result.stdout);
        if (!data) {
          return { ok: false, error: "Invalid xlsx_recalc output" };
        }
        return {
          ok: data.ok ?? false,
          path,
          status: data.status,
          total_formulas: data.total_formulas,
          total_errors: data.total_errors,
          error_summary: data.error_summary
        };
      }
    }),
    createSdkJsonResultTool({
      name: "pdf_tools",
      description: "PDF 合并/拆分/旋转/水印/加密/提取图片。",
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
        const data = safeParseJson(result.stdout);
        if (!data) {
          return { ok: false, error: "Invalid pdf_tools output" };
        }
        return {
          ok: data.ok ?? false,
          action,
          input_paths: inputPaths,
          output_path: outputPath,
          message: data.message
        };
      }
    }),
    createSdkJsonResultTool({
      name: "office_extract_style",
      description: "提取文档设计样式规范（颜色、字体、布局）。",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", minLength: 1 },
          output_path: { type: "string", minLength: 1 }
        },
        required: ["path"]
      },
      async call(args, context) {
        const path = resolveInputPath(requiredString(args.path, "path"), context.cwd);
        const outputPath = args.output_path ? resolveInputPath(requiredString(args.output_path, "output_path"), context.cwd) : addSuffix(path, ".style.yaml");
        const result = await executor.runJsScript("extract_style.mjs", [path, outputPath]);
        if (!result.ok) {
          return { ok: false, error: result.stderr ?? result.stdout ?? "office_extract_style failed" };
        }
        const data = safeParseJson(result.stdout);
        if (!data) {
          return { ok: false, error: "Invalid office_extract_style output" };
        }
        return {
          ok: data.ok ?? false,
          path: data.path ?? path,
          output_path: data.output_path ?? outputPath,
          format: data.format,
          source: data.source,
          slide_size: data.slide_size,
          color_palette: data.color_palette,
          fonts: data.fonts,
          spacing: data.spacing,
          layout_patterns: data.layout_patterns,
          theme_name: data.theme_name,
          slide_count: data.slide_count,
          page: data.page,
          styles: data.styles,
          has_header: data.has_header,
          has_footer: data.has_footer,
        };
      }
    }),
    createSdkJsonResultTool({
      name: "office_accept_changes",
      description: "接受 Word 修订（Tracked Changes）。",
      inputSchema: {
        type: "object",
        properties: {
          input_path: { type: "string", minLength: 1 },
          output_path: { type: "string", minLength: 1 }
        },
        required: ["input_path", "output_path"]
      },
      async call(args, context) {
        const inputPath = resolveInputPath(requiredString(args.input_path, "input_path"), context.cwd);
        const outputPath = resolveInputPath(requiredString(args.output_path, "output_path"), context.cwd);
        const result = await executor.runPythonScript("accept_changes.py", [inputPath, outputPath]);
        if (!result.ok) {
          return { ok: false, error: result.stderr ?? result.stdout ?? "office_accept_changes failed" };
        }
        const data = safeParseJson(result.stdout);
        if (!data) {
          return { ok: false, error: "Invalid office_accept_changes output" };
        }
        return {
          ok: data.ok ?? false,
          input_path: inputPath,
          output_path: outputPath,
          message: data.message
        };
      }
    }),
    createSdkJsonResultTool({
      name: "info_extract",
      description: "从文档中提取关键信息。支持合同、报告、简历等文档的信息提取，自动分配信息提取专家并分步骤执行。",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", minLength: 1, description: "要提取信息的文档路径" },
          extraction_type: { type: "string", description: "提取类型：contract（合同）、resume（简历）、report（报告）等" }
        },
        required: ["path"]
      },
      async call(args, context) {
        const path = resolveInputPath(requiredString(args.path, "path"), context.cwd);
        const extractionType = (args.extraction_type as string) || "contract";

        const result = await executor.runPythonScript("info_extract.py", [path, extractionType]);
        if (!result.ok) {
          return { ok: false, error: result.stderr ?? result.stdout ?? "info_extract failed" };
        }
        const data = safeParseJson(result.stdout);
        if (!data || typeof data !== "object") {
          return { ok: false, error: "Invalid info_extract output" };
        }
        const obj = data as Record<string, unknown>;
        return {
          ok: obj.ok ?? false,
          path,
          extraction_type: extractionType,
          expert: obj.expert,
          configConfirmed: obj.configConfirmed ?? true,
          steps: obj.steps
        };
      }
    }),
    createSdkJsonResultTool({
      name: "info_extract",
      description: "从文档中提取关键信息。支持合同、报告、简历等文档的信息提取，自动分配信息提取专家并分步骤执行。",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", minLength: 1, description: "要提取信息的文档路径" },
          extraction_type: { type: "string", description: "提取类型：contract（合同）、resume（简历）、report（报告）等" }
        },
        required: ["path"]
      },
      async call(args, context) {
        const path = resolveInputPath(requiredString(args.path, "path"), context.cwd);
        const extractionType = (args.extraction_type as string) || "contract";

        const result = await executor.runPythonScript("info_extract.py", [path, extractionType]);
        if (!result.ok) {
          return { ok: false, error: result.stderr ?? result.stdout ?? "info_extract failed" };
        }
        const data = safeParseJson(result.stdout);
        if (!data || typeof data !== "object") {
          return { ok: false, error: "Invalid info_extract output" };
        }
        const obj = data as Record<string, unknown>;
        return {
          ok: obj.ok ?? false,
          path,
          extraction_type: extractionType,
          expert: obj.expert,
          configConfirmed: obj.configConfirmed ?? true,
          steps: obj.steps
        };
      }
    }),
    createSdkJsonResultTool({
      name: "office_thumbnail",
      description: "为 PPT 生成缩略图网格。",
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
        const path = resolveInputPath(requiredString(args.path, "path"), context.cwd);
        const outputPrefix = args.output_prefix ? resolveInputPath(requiredString(args.output_prefix, "output_prefix"), context.cwd) : resolvePath(context.cwd, "thumbnails");
        const cols = clampNumber(args.cols, 3, 1, 12);
        const result = await executor.runPythonScript("thumbnail.py", [path, outputPrefix, String(cols)]);
        if (!result.ok) {
          return { ok: false, error: result.stderr ?? result.stdout ?? "office_thumbnail failed" };
        }
        const data = safeParseJson(result.stdout);
        if (!data) {
          return { ok: false, error: "Invalid office_thumbnail output" };
        }
        return {
          ok: data.ok ?? false,
          path,
          output_prefix: outputPrefix,
          outputs: data.outputs
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
