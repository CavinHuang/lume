import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createGuanlanRuntime,
  downloadFile,
  parseGuanlanSearchOutput,
  verifyPythonArchiveChecksum,
  PythonRuntimeChecksumError,
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

describe("downloadFile 超时与清理（#548）", () => {
  test("服务端停摆时按总时长超时并删除半截文件", async () => {
    const server = createServer(() => {
      // 故意不响应，模拟服务端停摆式下载
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const { port } = server.address() as AddressInfo;
    const destination = join(tmpdir(), `lume-download-test-${process.pid}.bin`);
    try {
      // 先制造半截文件，验证失败后被清理
      writeFileSync(destination, "partial");
      await expect(
        downloadFile(`http://127.0.0.1:${port}/x`, destination, { totalTimeoutMs: 300 })
      ).rejects.toThrow("总时长超过");
      expect(existsSync(destination)).toBeFalse();
    } finally {
      server.close();
    }
  });

  test("响应头后传输停摆时 idle 超时生效并删除半截文件", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-length": "1000" });
      res.write("chunk"); // 发一段后挂起不继续写，触发空闲检测
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const { port } = server.address() as AddressInfo;
    const destination = join(tmpdir(), `lume-download-idle-${process.pid}.bin`);
    try {
      await expect(
        downloadFile(`http://127.0.0.1:${port}/x`, destination, {
          totalTimeoutMs: 4_000,
          idleTimeoutMs: 200
        })
      ).rejects.toThrow("空闲超时");
      expect(existsSync(destination)).toBeFalse();
    } finally {
      server.close();
      server.closeAllConnections();
    }
  });

  test("传输中途 socket reset 时立即失败并删除半截文件（#548 核心通道）", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-length": "1000" });
      res.write("partial");
      setTimeout(() => res.destroy(), 50); // 中途强制断开，客户端 response 流 emit error
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const { port } = server.address() as AddressInfo;
    const destination = join(tmpdir(), `lume-download-reset-${process.pid}.bin`);
    try {
      await expect(
        downloadFile(`http://127.0.0.1:${port}/x`, destination, { totalTimeoutMs: 4_000 })
      ).rejects.toThrow();
      expect(existsSync(destination)).toBeFalse();
    } finally {
      server.close();
      server.closeAllConnections();
    }
  });

  test("连接拒绝时立即失败且不残留文件", async () => {
    const destination = join(tmpdir(), `lume-download-refused-${process.pid}.bin`);
    await expect(downloadFile("http://127.0.0.1:1/x", destination)).rejects.toThrow();
    expect(existsSync(destination)).toBeFalse();
  });

  test("重定向到白名单外地址时拒绝（SSRF 加固）", async () => {
    for (const location of ["http://10.255.255.1/evil", "https://10.255.255.1/evil"]) {
      const server = createServer((_req, res) => {
        res.writeHead(302, { location });
        res.end();
      });
      await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
      const { port } = server.address() as AddressInfo;
      const destination = join(tmpdir(), `lume-download-redirect-${process.pid}.bin`);
      try {
        // 两例分别钉死 https-only 与 host 白名单两个拒绝条件
        await expect(
          downloadFile(`http://127.0.0.1:${port}/x`, destination, { totalTimeoutMs: 4_000 })
        ).rejects.toThrow("拒绝重定向至非预期地址");
        expect(existsSync(destination)).toBeFalse();
      } finally {
        server.close();
        server.closeAllConnections();
      }
    }
  });

  test("SHA256 校验：内容不匹配拒绝安装，未收录平台跳过（供应链防护）", () => {
    const knownName = "cpython-3.11.15+20260414-aarch64-apple-darwin-install_only_stripped.tar.gz";
    const badFile = join(tmpdir(), `lume-checksum-bad-${process.pid}.bin`);
    const skipFile = join(tmpdir(), `lume-checksum-skip-${process.pid}.bin`);
    writeFileSync(badFile, "not-python");
    writeFileSync(skipFile, "whatever");
    try {
      expect(() => verifyPythonArchiveChecksum(badFile, knownName)).toThrow(PythonRuntimeChecksumError);
      // 表外名称=未收录平台，跳过校验不抛
      expect(() => verifyPythonArchiveChecksum(skipFile, "unknown-platform-archive.tar.gz")).not.toThrow();
    } finally {
      rmSync(badFile, { force: true });
      rmSync(skipFile, { force: true });
    }
  });
});
