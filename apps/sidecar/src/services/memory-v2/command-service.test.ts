import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MemoryCommandService } from "./command-service";
import { createMemoryV2Store } from "./markdown-store";
import { getMemoryV2ScopePaths } from "./paths";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lume-memory-command-"));
  process.env.LUME_CONFIG_DIR = root;
});

afterEach(() => {
  delete process.env.LUME_CONFIG_DIR;
  rmSync(root, { recursive: true, force: true });
});

describe("MemoryCommandService", () => {
  test("infers global identity scope and writes a journal receipt", async () => {
    const receipt = await new MemoryCommandService().remember({
      workspaceSlug: "demo",
      content: "我的名字是 Cavin",
      scope: "auto",
      actor: "main_agent"
    });
    expect(receipt.action).toBe("created");
    expect(receipt.scope).toBe("global");
    expect(receipt.undoable).toBe(true);
    const entry = createMemoryV2Store().listEntries({ workspaceSlug: "demo", scopes: ["global"] })[0]!;
    expect(entry.frontmatter.semantic_role).toBe("identity");
    expect(entry.frontmatter.revision).toBe(1);
    expect(entry.frontmatter.evidence_refs[0]?.type).toBe("manual");
  });

  test("filters secrets before durable write", async () => {
    const receipt = await new MemoryCommandService().remember({
      workspaceSlug: "demo",
      content: "API token = sk-abcdefghijklmnopqrstuvwxyz",
      actor: "main_agent"
    });
    expect(receipt.action).toBe("ignored");
    expect(createMemoryV2Store().listEntries({ workspaceSlug: "demo" })).toHaveLength(0);
  });

  test("explicit correction supersedes while background conflict stays pending", async () => {
    const service = new MemoryCommandService();
    await service.remember({
      workspaceSlug: "demo",
      content: "默认回答语言是英文",
      scope: "global",
      semanticRole: "preference",
      claim: { subject: "user", predicate: "response_language", object: "English" },
      actor: "user"
    });
    const pending = await service.remember({
      workspaceSlug: "demo",
      content: "默认回答语言是中文",
      scope: "global",
      semanticRole: "preference",
      claim: { subject: "user", predicate: "response_language", object: "Chinese" },
      actor: "background_extract"
    });
    expect(pending.action).toBe("pending");

    const corrected = await service.remember({
      workspaceSlug: "demo",
      content: "纠正：默认回答语言是中文",
      scope: "global",
      semanticRole: "preference",
      claim: { subject: "user", predicate: "response_language", object: "Chinese" },
      actor: "user",
      explicitCorrection: true
    });
    expect(corrected.action).toBe("superseded");
    const entries = createMemoryV2Store().listEntries({
      workspaceSlug: "demo",
      scopes: ["global"],
      includeStatuses: ["active", "superseded"]
    });
    expect(entries.filter((entry) => entry.frontmatter.status === "active")).toHaveLength(1);
    expect(entries.filter((entry) => entry.frontmatter.status === "superseded")).toHaveLength(1);
  });

  test("updates pin and validity and moves an entry across scopes", async () => {
    const service = new MemoryCommandService();
    const created = await service.remember({
      workspaceSlug: "demo",
      content: "项目默认使用 Bun",
      scope: "workspace",
      actor: "user"
    });
    const id = created.memoryIds[0]!;
    const validTo = "2027-01-01T23:59:59.999Z";
    service.update({
      workspaceSlug: "demo",
      id,
      scope: "workspace",
      pinned: true,
      validTo,
      actor: "user"
    });
    service.moveScope({
      workspaceSlug: "demo",
      id,
      scope: "workspace",
      targetScope: "global"
    });
    const moved = createMemoryV2Store().listEntries({ scopes: ["global"] })
      .find((entry) => entry.frontmatter.id === id);
    expect(moved?.frontmatter.pinned).toBe(true);
    expect(moved?.frontmatter.valid_to).toBe(validTo);
    expect(createMemoryV2Store().listEntries({ workspaceSlug: "demo", scopes: ["workspace"] }))
      .toHaveLength(0);
  });

  test("records displayable before and after snapshots for updates and archives", async () => {
    const service = new MemoryCommandService();
    const created = await service.remember({
      workspaceSlug: "demo",
      content: "项目默认使用 Bun",
      scope: "workspace",
      actor: "user"
    });
    const id = created.memoryIds[0]!;

    const updated = service.update({
      workspaceSlug: "demo",
      id,
      scope: "workspace",
      statement: "项目默认使用 Bun 和 TypeScript",
      actor: "user"
    });
    expect(updated.action).toBe("updated");

    service.archive({ workspaceSlug: "demo", id, scope: "workspace", actor: "user" });
    const journalDir = getMemoryV2ScopePaths({ scope: "workspace", workspaceSlug: "demo" }).journalDir;
    const journal = readdirSync(journalDir).find((name) => name.endsWith(".jsonl"))!;
    const records = readFileSync(join(journalDir, journal), "utf-8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { receipt: { mutationId: string }; before: Array<{ statement?: string; status?: string }>; after: Array<{ statement?: string; status?: string }> });
    const updatedRecord = records.find((record) => record.receipt.mutationId === updated.mutationId)!;
    const archivedRecord = records.at(-1)!;

    expect(updatedRecord.before[0]?.statement).toBe("项目默认使用 Bun");
    expect(updatedRecord.after[0]?.statement).toBe("项目默认使用 Bun 和 TypeScript");
    expect(archivedRecord.before[0]?.statement).toBe("项目默认使用 Bun 和 TypeScript");
    expect(archivedRecord.after[0]?.status).toBe("archived");
  });

  test("records the restored state created by an undo mutation", async () => {
    const service = new MemoryCommandService();
    const created = await service.remember({ workspaceSlug: "demo", content: "使用中文", scope: "global", actor: "user" });
    const id = created.memoryIds[0]!;

    const undone = service.undo({ workspaceSlug: "demo", mutationId: created.mutationId });
    expect(undone.summary).toBe("已撤销记忆变更");

    const entry = createMemoryV2Store().listEntries({ scopes: ["global"], includeStatuses: ["archived"] })
      .find((item) => item.frontmatter.id === id)!;
    expect(entry.frontmatter.status).toBe("archived");
    const journalDir = getMemoryV2ScopePaths({ scope: "global" }).journalDir;
    const journal = readdirSync(journalDir).find((name) => name.endsWith(".jsonl"))!;
    const records = readFileSync(join(journalDir, journal), "utf-8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { receipt: { summary: string }; before: Array<{ status?: string }>; after: Array<{ status?: string }> });
    const undoRecord = records.find((record) => record.receipt.summary === "已撤销记忆变更")!;
    expect(undoRecord.before[0]?.status).toBe("active");
    expect(undoRecord.after[0]?.status).toBe("archived");
  });
});
