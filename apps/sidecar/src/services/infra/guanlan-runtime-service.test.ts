import { afterEach, describe, expect, test } from "bun:test";
import {
  createGuanlanRuntime,
  parseGuanlanSearchOutput,
  type GuanlanCommandRunner
} from "./guanlan-runtime-service";

describe("guanlan-runtime-service", () => {
  const originalLumePython = process.env.LUME_PYTHON;

  afterEach(() => {
    if (originalLumePython === undefined) {
      delete process.env.LUME_PYTHON;
    } else {
      process.env.LUME_PYTHON = originalLumePython;
    }
  });

  test("优先使用 LUME_PYTHON 指定的 Python", async () => {
    process.env.LUME_PYTHON = "/custom/python";
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: GuanlanCommandRunner = async (command, args) => {
      calls.push({ command, args });
      return { code: 0, stdout: args.includes("--version") ? "Python 3.11.9" : "guanlan 1.0.0", stderr: "" };
    };
    const runtime = createGuanlanRuntime({ runner });

    const status = await runtime.getStatus();

    expect(status.ok).toBeTrue();
    expect(status.pythonPath).toBe("/custom/python");
    expect(calls[0]).toEqual({ command: "/custom/python", args: ["--version"] });
  });

  test("找不到 Python 时返回可解释错误", async () => {
    delete process.env.LUME_PYTHON;
    const runner: GuanlanCommandRunner = async () => ({ code: 127, stdout: "", stderr: "not found" });
    const runtime = createGuanlanRuntime({
      runner,
      pythonCandidates: ["missing-python"]
    });

    const status = await runtime.getStatus();

    expect(status.ok).toBeFalse();
    expect(status.error).toContain("未找到 Python");
  });

  test("ensureReady 在缺少 Python 时会尝试下载托管运行时", async () => {
    let downloaded = false;
    const calls: string[] = [];
    const runner: GuanlanCommandRunner = async (command, args) => {
      calls.push([command, ...args].join(" "));
      if (command === "managed-python" && downloaded && args[0] === "--version") {
        return { code: 0, stdout: "Python 3.11.9", stderr: "" };
      }
      if (command === "managed-python" && downloaded && args.join(" ") === "-m guanlan --version") {
        return { code: 0, stdout: "guanlan 1.0.0", stderr: "" };
      }
      return { code: 127, stdout: "", stderr: "not found" };
    };
    const runtime = createGuanlanRuntime({
      runner,
      pythonCandidates: ["managed-python"],
      downloadPython: async () => {
        downloaded = true;
        return true;
      }
    });

    const status = await runtime.ensureReady();

    expect(status.ok).toBeTrue();
    expect(status.pythonPath).toBe("managed-python");
    expect(calls.filter((call) => call === "managed-python --version").length).toBe(2);
  });

  test("guanlan 缺失时 ensure 会尝试 pip 安装", async () => {
    process.env.LUME_PYTHON = "/custom/python";
    const calls: string[] = [];
    const runner: GuanlanCommandRunner = async (command, args) => {
      calls.push([command, ...args].join(" "));
      if (args[0] === "--version") {
        return { code: 0, stdout: "Python 3.11.9", stderr: "" };
      }
      if (args.join(" ") === "-m guanlan --version" && calls.filter((call) => call.includes("-m guanlan --version")).length === 1) {
        return { code: 1, stdout: "", stderr: "No module named guanlan" };
      }
      return { code: 0, stdout: "guanlan 1.0.0", stderr: "" };
    };
    const runtime = createGuanlanRuntime({ runner });

    const status = await runtime.ensureReady();

    expect(status.ok).toBeTrue();
    expect(calls).toContain("/custom/python -m pip install --upgrade guanlan");
  });

  test("解析 guanlan JSON 搜索结果", () => {
    const results = parseGuanlanSearchOutput(JSON.stringify({
      results: [
        {
          title: "Result",
          url: "https://example.com",
          snippet: "Snippet",
          source_type: "web",
          evidence_role: "primary",
          domain: "example.com"
        }
      ]
    }));

    expect(results).toEqual([{
      title: "Result",
      url: "https://example.com",
      snippet: "Snippet",
      sourceType: "web",
      evidenceRole: "primary",
      domain: "example.com"
    }]);
  });

  test("runSearch 会 clamp limit 并调用 guanlan search", async () => {
    process.env.LUME_PYTHON = "/custom/python";
    const calls: string[] = [];
    const runner: GuanlanCommandRunner = async (command, args) => {
      calls.push([command, ...args].join(" "));
      if (args[0] === "--version") {
        return { code: 0, stdout: "Python 3.11.9", stderr: "" };
      }
      if (args.join(" ") === "-m guanlan --version") {
        return { code: 0, stdout: "guanlan 1.0.0", stderr: "" };
      }
      return {
        code: 0,
        stdout: JSON.stringify([{ title: "Title", url: "https://example.com" }]),
        stderr: ""
      };
    };
    const runtime = createGuanlanRuntime({ runner });

    const results = await runtime.search({ query: "测试", limit: 50 });

    expect(results[0]?.url).toBe("https://example.com");
    expect(calls.some((call) => call.includes("-m guanlan search 测试 --profile china --limit 10 --json"))).toBeTrue();
  });
});
