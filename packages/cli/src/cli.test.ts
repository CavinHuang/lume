import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import cliPackage from "../package.json"

import { createCliApp, getCliVersion } from "./cli"
import { main } from "./bin"
import { CliCommandError } from "./errors"

describe("CliCommandError", () => {
  test("preserves stable code and exitCode", () => {
    const error = new CliCommandError("boom", {
      code: "CLI_TEST",
      exitCode: 9,
    })

    expect(error.code).toBe("CLI_TEST")
    expect(error.exitCode).toBe(9)
  })
})

describe("createCliApp", () => {
  test("creates a cac app that registers the workspaces command", () => {
    const app = createCliApp({
      async listWorkspaces() {
        return []
      },
    })

    expect(app.matchedCommand).toBeUndefined()
    app.parse(["node", "lume", "workspaces"], { run: false })
    expect(app.matchedCommand?.name).toBe("workspaces")
  })

  test("workspaces command writes JSON output", async () => {
    const lines: string[] = []
    const app = createCliApp(
      {
        async listWorkspaces() {
          return [
            {
              id: "ws_1",
              name: "Alpha",
              slug: "alpha",
              createdAt: 1,
              updatedAt: 2,
            },
          ]
        },
      },
      {
        stdout: {
          log(value: string) {
            lines.push(value)
          },
        },
      },
    )

    app.parse(["node", "lume", "workspaces"], { run: false })
    await app.runMatchedCommand()

    expect(lines).toEqual([
      JSON.stringify({
        workspaces: [
          {
            id: "ws_1",
            name: "Alpha",
            slug: "alpha",
            createdAt: 1,
            updatedAt: 2,
          },
        ],
      }),
    ])
  })

  test("status command writes JSON output", async () => {
    const lines: string[] = []
    const app = createCliApp(
      {
        async status() {
          return {
            bun: { available: true, path: "bun", version: "1.0.0", source: "system", error: null },
            git: { available: true, path: "git", version: "2.0.0", error: null },
            envLoaded: true,
            initializedAt: 1,
          }
        },
        async listWorkspaces() {
          return []
        },
      },
      {
        stdout: {
          log(value: string) {
            lines.push(value)
          },
        },
      },
    )

    app.parse(["node", "lume", "status"], { run: false })
    await app.runMatchedCommand()

    expect(lines).toEqual([
      JSON.stringify({
        bun: { available: true, path: "bun", version: "1.0.0", source: "system", error: null },
        git: { available: true, path: "git", version: "2.0.0", error: null },
        envLoaded: true,
        initializedAt: 1,
      }),
    ])
  })

  test("health command writes JSON output", async () => {
    const lines: string[] = []
    const app = createCliApp(
      {
        async health() {
          return { ok: true, source: "sidecar" as const }
        },
        async listWorkspaces() {
          return []
        },
      },
      {
        stdout: {
          log(value: string) {
            lines.push(value)
          },
        },
      },
    )

    app.parse(["node", "lume", "health"], { run: false })
    await app.runMatchedCommand()

    expect(lines).toEqual([JSON.stringify({ ok: true, source: "sidecar" })])
  })

  test("workspace create calls runtime and writes returned object JSON", async () => {
    const lines: string[] = []
    const calls: Array<{ name: string; slug?: string }> = []
    const app = createCliApp(
      {
        async status() {
          return {
            bun: { available: true, path: "bun", version: "1.0.0", source: "system", error: null },
            git: { available: true, path: "git", version: "2.0.0", error: null },
            envLoaded: true,
            initializedAt: 1,
          }
        },
        async health() {
          return { ok: true, source: "sidecar" as const }
        },
        async listWorkspaces() {
          return []
        },
        async createWorkspace(input) {
          calls.push(input)
          return {
            id: "ws_new",
            name: input.name,
            slug: input.slug ?? "new-space",
            createdAt: 10,
            updatedAt: 10,
          }
        },
        async listThreads() {
          return []
        },
        async createThread() {
          throw new Error("not implemented in test")
        },
        async getThreadMessages() {
          return []
        },
        async listFiles() {
          return []
        },
        async addFileToThread() {
          throw new Error("not implemented in test")
        },
        async addFileToWorkspace() {
          throw new Error("not implemented in test")
        },
      },
      {
        stdout: {
          log(value: string) {
            lines.push(value)
          },
        },
      },
    )

    app.parse(["node", "lume", "workspace", "create", "New Space", "--slug", "new-space"], { run: false })
    expect(app.matchedCommand?.name).toBe("workspace create")
    await app.runMatchedCommand()

    expect(calls).toEqual([{ name: "New Space", slug: "new-space" }])
    expect(lines).toEqual([
      JSON.stringify({
        id: "ws_new",
        name: "New Space",
        slug: "new-space",
        createdAt: 10,
        updatedAt: 10,
      }),
    ])
  })

  test("threads supports --workspace and optional limit", async () => {
    const lines: string[] = []
    const calls: Array<{ workspaceSlug?: string; limit?: number }> = []
    const app = createCliApp(
      {
        async status() {
          return {
            bun: { available: true, path: "bun", version: "1.0.0", source: "system", error: null },
            git: { available: true, path: "git", version: "2.0.0", error: null },
            envLoaded: true,
            initializedAt: 1,
          }
        },
        async health() {
          return { ok: true, source: "sidecar" as const }
        },
        async listWorkspaces() {
          return []
        },
        async createWorkspace() {
          throw new Error("not implemented in test")
        },
        async listThreads(input) {
          calls.push(input)
          return [
            {
              id: "thread_1",
              title: "Hello",
              workspaceSlug: input.workspaceSlug,
              createdAt: 1,
              updatedAt: 2,
            },
          ]
        },
        async createThread() {
          throw new Error("not implemented in test")
        },
        async getThreadMessages() {
          return []
        },
        async listFiles() {
          return []
        },
        async addFileToThread() {
          throw new Error("not implemented in test")
        },
        async addFileToWorkspace() {
          throw new Error("not implemented in test")
        },
      },
      {
        stdout: {
          log(value: string) {
            lines.push(value)
          },
        },
      },
    )

    app.parse(["node", "lume", "threads", "5", "--workspace", "ws_1"], { run: false })
    await app.runMatchedCommand()

    expect(calls).toEqual([{ workspaceSlug: "ws_1", limit: 5 }])
    expect(lines).toEqual([
      JSON.stringify({
        threads: [
          {
            id: "thread_1",
            title: "Hello",
            workspaceSlug: "ws_1",
            createdAt: 1,
            updatedAt: 2,
          },
        ],
      }),
    ])
  })

  test("threads supports --workspace without a positional limit", async () => {
    const lines: string[] = []
    const calls: Array<{ workspaceSlug?: string; limit?: number }> = []
    const app = createCliApp(
      {
        async listWorkspaces() {
          return []
        },
        async listThreads(input) {
          calls.push(input)
          return []
        },
      },
      {
        stdout: {
          log(value: string) {
            lines.push(value)
          },
        },
      },
    )

    app.parse(["node", "lume", "threads", "--workspace", "ws_slug"], { run: false })
    await app.runMatchedCommand()

    expect(calls).toEqual([{ workspaceSlug: "ws_slug", limit: undefined }])
    expect(lines).toEqual([JSON.stringify({ threads: [] })])
  })

  test("thread messages supports an optional limit", async () => {
    const lines: string[] = []
    const calls: Array<{ threadId: string; limit?: number }> = []
    const app = createCliApp(
      {
        async listWorkspaces() {
          return []
        },
        async getThreadMessages(input) {
          calls.push(input)
          return []
        },
      },
      {
        stdout: {
          log(value: string) {
            lines.push(value)
          },
        },
      },
    )

    app.parse(["node", "lume", "thread", "messages", "thread_1", "3"], { run: false })
    expect(app.matchedCommand?.name).toBe("thread messages")
    await app.runMatchedCommand()

    expect(calls).toEqual([{ threadId: "thread_1", limit: 3 }])
    expect(lines).toEqual([JSON.stringify({ messages: [] })])
  })

  test("thread create normalizes the composite command and writes JSON output", async () => {
    const lines: string[] = []
    const calls: Array<{ workspaceSlug?: string }> = []
    const app = createCliApp(
      {
        async listWorkspaces() {
          return []
        },
        async createThread(input) {
          calls.push(input)
          return {
            id: "thread_1",
            title: "New Thread",
            workspaceSlug: input.workspaceSlug,
            createdAt: 1,
            updatedAt: 2,
          }
        },
      },
      {
        stdout: {
          log(value: string) {
            lines.push(value)
          },
        },
      },
    )

    app.parse(["node", "lume", "thread", "create", "--workspace", "ws_1"], { run: false })

    expect(app.matchedCommand?.name).toBe("thread create")
    await app.runMatchedCommand()

    expect(calls).toEqual([{ workspaceSlug: "ws_1" }])
    expect(lines).toEqual([
      JSON.stringify({
        id: "thread_1",
        title: "New Thread",
        workspaceSlug: "ws_1",
        createdAt: 1,
        updatedAt: 2,
      }),
    ])
  })

  test("thread send writes accepted JSON output", async () => {
    const lines: string[] = []
    const calls: Array<{ threadId: string; text: string }> = []
    const app = createCliApp(
      {
        async listWorkspaces() {
          return []
        },
        async sendThreadMessage(input) {
          calls.push(input)
          return {
            accepted: {
              ok: true,
              threadId: input.threadId,
              mode: "sent" as const,
              queuedCount: 0,
            },
            text: "final reply",
          }
        },
      },
      {
        stdout: {
          log(value: string) {
            lines.push(value)
          },
        },
      },
    )

    app.parse(["node", "lume", "thread", "send", "thread_1", "hello there"], { run: false })
    expect(app.matchedCommand?.name).toBe("thread send")
    await app.runMatchedCommand()

    expect(calls).toEqual([{ threadId: "thread_1", text: "hello there" }])
    expect(lines).toEqual([
      JSON.stringify({
        ok: true,
        threadId: "thread_1",
        mode: "sent",
        queuedCount: 0,
      }),
    ])
  })

  test("ask writes final text output", async () => {
    const lines: string[] = []
    const calls: Array<{ text: string; workspaceSlug?: string; threadId?: string }> = []
    const app = createCliApp(
      {
        async listWorkspaces() {
          return []
        },
        async ask(input) {
          calls.push(input)
          return "assistant says hi"
        },
      },
      {
        stdout: {
          log(value: string) {
            lines.push(value)
          },
        },
      },
    )

    app.parse(["node", "lume", "ask", "hello", "--workspace", "alpha"], { run: false })
    expect(app.matchedCommand?.name).toBe("ask")
    await app.runMatchedCommand()

    expect(calls).toEqual([{ text: "hello", workspaceSlug: "alpha" }])
    expect(lines).toEqual(["assistant says hi"])
  })

  test("ask rejects when both --workspace and --thread are provided", async () => {
    const app = createCliApp({
      async listWorkspaces() {
        return []
      },
      async ask() {
        return "should not be called"
      },
    })

    app.parse(["node", "lume", "ask", "hello", "--workspace", "alpha", "--thread", "thread_1"], { run: false })

    await expect(app.runMatchedCommand()).rejects.toMatchObject({
      code: "USAGE_ERROR",
      exitCode: 2,
      message: 'Exactly one of "--workspace" or "--thread" may be provided',
    })
  })

  test("threads rejects an invalid limit", async () => {
    const app = createCliApp({
      async listWorkspaces() {
        return []
      },
      async listThreads() {
        return []
      },
    })

    app.parse(["node", "lume", "threads", "0"], { run: false })

    await expect(app.runMatchedCommand()).rejects.toMatchObject({
      code: "USAGE_ERROR",
      exitCode: 2,
      message: 'Argument "[limit]" must be a positive integer',
    })
  })

  test("threads rejects malformed numeric limit strings", async () => {
    const app = createCliApp({
      async listWorkspaces() {
        return []
      },
      async listThreads() {
        return []
      },
    })

    app.parse(["node", "lume", "threads", "3abc"], { run: false })

    await expect(app.runMatchedCommand()).rejects.toMatchObject({
      code: "USAGE_ERROR",
      exitCode: 2,
      message: 'Argument "[limit]" must be a positive integer',
    })
  })

  test("files requires exactly one of --thread or --workspace", async () => {
    const app = createCliApp({
      async status() {
        return {
          bun: { available: true, path: "bun", version: "1.0.0", source: "system", error: null },
          git: { available: true, path: "git", version: "2.0.0", error: null },
          envLoaded: true,
          initializedAt: 1,
        }
      },
      async health() {
        return { ok: true, source: "sidecar" as const }
      },
      async listWorkspaces() {
        return []
      },
      async createWorkspace() {
        throw new Error("not implemented in test")
      },
      async listThreads() {
        return []
      },
      async createThread() {
        throw new Error("not implemented in test")
      },
      async getThreadMessages() {
        return []
      },
      async listFiles() {
        return []
      },
      async addFileToThread() {
        throw new Error("not implemented in test")
      },
      async addFileToWorkspace() {
        throw new Error("not implemented in test")
      },
    })

    app.parse(["node", "lume", "files"], { run: false })

    await expect(app.runMatchedCommand()).rejects.toMatchObject({
      code: "USAGE_ERROR",
      exitCode: 2,
      message: 'Exactly one of "--thread" or "--workspace" is required',
    })
  })

  test("files rejects when both --thread and --workspace are provided", async () => {
    const app = createCliApp({
      async listWorkspaces() {
        return []
      },
      async listFiles() {
        return []
      },
    })

    app.parse(["node", "lume", "files", "--thread", "thread_1", "--workspace", "ws_1"], { run: false })

    await expect(app.runMatchedCommand()).rejects.toMatchObject({
      code: "USAGE_ERROR",
      exitCode: 2,
      message: 'Exactly one of "--thread" or "--workspace" is required',
    })
  })

  test("files writes JSON output for a workspace target", async () => {
    const lines: string[] = []
    const calls: Array<{ threadId?: string; workspaceSlug?: string }> = []
    const app = createCliApp(
      {
        async listWorkspaces() {
          return []
        },
        async listFiles(input) {
          calls.push(input)
          return [{ id: "file_1", path: "notes.txt" }]
        },
      },
      {
        stdout: {
          log(value: string) {
            lines.push(value)
          },
        },
      },
    )

    app.parse(["node", "lume", "files", "--workspace", "ws_1"], { run: false })
    await app.runMatchedCommand()

    expect(calls).toEqual([{ workspaceSlug: "ws_1" }])
    expect(lines).toEqual([JSON.stringify({ files: [{ id: "file_1", path: "notes.txt" }] })])
  })

  test("file add normalizes the composite command and writes JSON output", async () => {
    const lines: string[] = []
    const calls: Array<{ sourcePath: string; threadId?: string }> = []
    const app = createCliApp(
      {
        async listWorkspaces() {
          return []
        },
        async addFileToThread(input) {
          calls.push(input)
          return { id: "file_1", path: input.sourcePath, threadId: input.threadId }
        },
      },
      {
        stdout: {
          log(value: string) {
            lines.push(value)
          },
        },
      },
    )

    app.parse(["node", "lume", "file", "add", "notes.txt", "--thread", "thread_1"], { run: false })

    expect(app.matchedCommand?.name).toBe("file add")
    await app.runMatchedCommand()

    expect(calls).toEqual([{ sourcePath: "notes.txt", threadId: "thread_1" }])
    expect(lines).toEqual([
      JSON.stringify({ id: "file_1", path: "notes.txt", threadId: "thread_1" }),
    ])
  })

  test("composite command normalization is derived from registered commands", () => {
    const app = createCliApp({
      async listWorkspaces() {
        return []
      },
    })

    app.command("demo run", "Dynamically added composite command").action(() => {})
    app.parse(["node", "lume", "demo", "run"], { run: false })

    expect(app.matchedCommand?.name).toBe("demo run")
  })

  test("reads CLI version from package metadata", () => {
    expect(getCliVersion()).toBe(cliPackage.version)
  })
})

describe("main", () => {
  test("invokes the CLI entrypoint and writes JSON to stdout", async () => {
    const stdout: string[] = []

    const exitCode = await main(
      ["node", "lume", "workspaces"],
      {
        createRuntime() {
          return {
            async listWorkspaces() {
              return []
            },
          }
        },
      },
      {
        stdout: {
          log(message: string) {
            stdout.push(message)
          },
        },
      },
    )

    expect(exitCode).toBe(0)
    expect(stdout).toEqual([JSON.stringify({ workspaces: [] })])
  })

  test("serializes thrown errors through stderr", async () => {
    const stderr: string[] = []

    const exitCode = await main(
      ["node", "lume", "workspaces"],
      {
        createRuntime() {
          return {
            async listWorkspaces() {
              throw new CliCommandError("broken", {
                code: "CLI_BROKEN",
                exitCode: 7,
              })
            },
          }
        },
      },
      {
        stderr: {
          error(message: string) {
            stderr.push(message)
          },
        },
      },
    )

    expect(exitCode).toBe(7)
    expect(stderr).toEqual([
      JSON.stringify({
        error: {
          code: "CLI_BROKEN",
          message: "broken",
        },
      }),
    ])
  })

  test.each([
    ["--help"],
    ["--version"],
  ])("handles %s without creating the runtime", async (flag) => {
    const stderr: string[] = []

    const exitCode = await main(
      ["node", "lume", flag],
      {
        createRuntime() {
          throw new Error("runtime failed")
        },
      },
      {
        stderr: {
          error(message: string) {
            stderr.push(message)
          },
        },
      },
    )

    expect(exitCode).toBe(0)
    expect(stderr).toEqual([])
  })

  test("handles --help without loading the default runtime", async () => {
    const stderr: string[] = []

    const exitCode = await main(
      ["node", "lume", "--help"],
      {
        createRuntime() {
          throw new Error("default runtime import should stay lazy")
        },
      },
      {
        stderr: {
          error(message: string) {
            stderr.push(message)
          },
        },
      },
    )

    expect(exitCode).toBe(0)
    expect(stderr).toEqual([])
  })

  test("fails unknown commands with structured stderr output", async () => {
    const stderr: string[] = []

    const exitCode = await main(
      ["node", "lume", "nope"],
      {
        createRuntime() {
          return {
            async listWorkspaces() {
              return []
            },
          }
        },
      },
      {
        stderr: {
          error(message: string) {
            stderr.push(message)
          },
        },
      },
    )

    expect(exitCode).toBe(1)
    expect(stderr).toEqual([
      JSON.stringify({
        error: {
          code: "CLI_UNKNOWN_COMMAND",
          message: 'Unknown command: "nope"',
        },
      }),
    ])
  })

  test("bin file executes the CLI when run directly", () => {
    const tempConfigDir = mkdtempSync(join(tmpdir(), "lume-cli-bin-test-"))

    try {
      const result = Bun.spawnSync({
        cmd: ["bun", "run", "src/bin.ts", "workspaces"],
        cwd: process.cwd(),
        env: {
          ...process.env,
          LUME_CONFIG_DIR: tempConfigDir,
        },
        stderr: "pipe",
        stdout: "pipe",
      })

      expect(result.exitCode).toBe(0)
      expect(result.stderr.toString().trim()).toBe("")

      const payload = JSON.parse(result.stdout.toString().trim()) as {
        workspaces: unknown[]
      }

      expect(payload).toEqual({
        workspaces: [],
      })
    } finally {
      rmSync(tempConfigDir, { recursive: true, force: true })
    }
  })

  test("status uses the real headless runtime contract", async () => {
    const stdout: string[] = []
    const stderr: string[] = []
    const previousConfigDir = process.env.LUME_CONFIG_DIR
    const tempConfigDir = mkdtempSync(join(tmpdir(), "lume-cli-main-status-"))
    const { createCliRuntime } = await import("@lume/sidecar/headless/cli-runtime")

    try {
      process.env.LUME_CONFIG_DIR = tempConfigDir

      const exitCode = await main(
        ["node", "lume", "status"],
        {
          createRuntime: createCliRuntime,
        },
        {
          stdout: {
            log(message: string) {
              stdout.push(message)
            },
          },
          stderr: {
            error(message: string) {
              stderr.push(message)
            },
          },
        },
      )

      expect(exitCode).toBe(0)
      expect(stderr).toEqual([])
      expect(stdout).toEqual([JSON.stringify({ ok: true, runtime: "ready" })])
    } finally {
      if (previousConfigDir === undefined) {
        delete process.env.LUME_CONFIG_DIR
      } else {
        process.env.LUME_CONFIG_DIR = previousConfigDir
      }
      rmSync(tempConfigDir, { recursive: true, force: true })
    }
  })

  test("real headless runtime flow keeps workspace-targeted thread and file commands on workspaceSlug", async () => {
    const stdout: string[] = []
    const stderr: string[] = []
    const previousConfigDir = process.env.LUME_CONFIG_DIR
    const tempConfigDir = mkdtempSync(join(tmpdir(), "lume-cli-main-workspace-"))
    const sourcePath = join(tempConfigDir, "brief.md")
    const { createCliRuntime } = await import("@lume/sidecar/headless/cli-runtime")

    writeFileSync(sourcePath, "# Brief\n", "utf-8")

    try {
      process.env.LUME_CONFIG_DIR = tempConfigDir

      const runtime = createCliRuntime()
      const workspace = await runtime.createWorkspace({
        name: "Alpha Workspace",
        slug: "alpha",
      })

      stdout.length = 0
      stderr.length = 0
      const createExitCode = await main(
        ["node", "lume", "thread", "create", "--workspace", workspace.slug],
        {
          createRuntime: createCliRuntime,
        },
        {
          stdout: {
            log(message: string) {
              stdout.push(message)
            },
          },
          stderr: {
            error(message: string) {
              stderr.push(message)
            },
          },
        },
      )

      expect(createExitCode).toBe(0)
      expect(stderr).toEqual([])
      expect(stdout).toHaveLength(1)
      const thread = JSON.parse(stdout[0] ?? "{}") as { id: string; workspaceSlug?: string }
      expect(thread.workspaceSlug).toBe(workspace.slug)

      stdout.length = 0
      const listThreadsExitCode = await main(
        ["node", "lume", "threads", "--workspace", workspace.slug],
        {
          createRuntime: createCliRuntime,
        },
        {
          stdout: {
            log(message: string) {
              stdout.push(message)
            },
          },
          stderr: {
            error(message: string) {
              stderr.push(message)
            },
          },
        },
      )

      expect(listThreadsExitCode).toBe(0)
      expect(stderr).toEqual([])
      expect(JSON.parse(stdout[0] ?? "{}")).toEqual({
        threads: [expect.objectContaining({ id: thread.id, workspaceSlug: workspace.slug })],
      })

      stdout.length = 0
      const addFileExitCode = await main(
        ["node", "lume", "file", "add", sourcePath, "--workspace", workspace.slug],
        {
          createRuntime: createCliRuntime,
        },
        {
          stdout: {
            log(message: string) {
              stdout.push(message)
            },
          },
          stderr: {
            error(message: string) {
              stderr.push(message)
            },
          },
        },
      )

      expect(addFileExitCode).toBe(0)
      expect(stderr).toEqual([])
      expect(JSON.parse(stdout[0] ?? "{}")).toEqual(expect.objectContaining({
        filename: "brief.md",
      }))

      stdout.length = 0
      const listFilesExitCode = await main(
        ["node", "lume", "files", "--workspace", workspace.slug],
        {
          createRuntime: createCliRuntime,
        },
        {
          stdout: {
            log(message: string) {
              stdout.push(message)
            },
          },
          stderr: {
            error(message: string) {
              stderr.push(message)
            },
          },
        },
      )

      expect(listFilesExitCode).toBe(0)
      expect(stderr).toEqual([])
      expect(JSON.parse(stdout[0] ?? "{}")).toEqual({
        files: [expect.objectContaining({ name: "brief.md" })],
      })
    } finally {
      if (previousConfigDir === undefined) {
        delete process.env.LUME_CONFIG_DIR
      } else {
        process.env.LUME_CONFIG_DIR = previousConfigDir
      }
      rmSync(tempConfigDir, { recursive: true, force: true })
    }
  })
})
