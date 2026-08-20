import { describe, expect, mock, test } from "bun:test";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createSdkOfficeTools } from "./create-office-tools";
import { OfficeToolExecutor } from "./office-tool-executor";

describe("office_convert convertOutputPath", () => {
  test("多段文件名剥最后一段扩展名，与 soffice 产物一致", () => {
    const executor = new OfficeToolExecutor(tmpdir());
    expect(executor.convertOutputPath("report.v2.docx", "/out", "pdf"))
      .toBe(resolve("/out", "report.v2.pdf"));
    expect(executor.convertOutputPath("report.docx", "/out", "pdf"))
      .toBe(resolve("/out", "report.pdf"));
  });
});

describe("office_validate autoRepair 接线", () => {
  test("默认不传 --auto-repair，显式 true 才传", async () => {
    const tools = createSdkOfficeTools();
    const validateTool = tools.find((tool) => tool.name === "office_validate");
    expect(validateTool).toBeDefined();

    const calls: Array<string[]> = [];
    const original = OfficeToolExecutor.prototype.runPythonScript;
    OfficeToolExecutor.prototype.runPythonScript = mock(async (_script: string, args: string[]) => {
      calls.push(args);
      return { ok: true, stdout: JSON.stringify({ ok: true }), stderr: "" };
    }) as unknown as typeof original;
    try {
      const context = { cwd: tmpdir() };
      await (validateTool!.call as (args: Record<string, unknown>, context: { cwd: string }) => Promise<unknown>)(
        { path: "a.docx" },
        context
      );
      await (validateTool!.call as (args: Record<string, unknown>, context: { cwd: string }) => Promise<unknown>)(
        { path: "a.docx", autoRepair: false },
        context
      );
      await (validateTool!.call as (args: Record<string, unknown>, context: { cwd: string }) => Promise<unknown>)(
        { path: "a.docx", autoRepair: true },
        context
      );
    } finally {
      OfficeToolExecutor.prototype.runPythonScript = original;
    }

    expect(calls.length).toBe(3);
    expect(calls[0]!.includes("--auto-repair")).toBe(false);
    expect(calls[1]!.includes("--auto-repair")).toBe(false);
    expect(calls[2]!.includes("--auto-repair")).toBe(true);
  });
});
