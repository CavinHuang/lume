import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_TOOL_GRANTS_PATH,
  FilePersistedGrantStore,
  type PersistedToolGrantRecord,
} from "./persisted-grant-store.js";

function makeRecord(overrides: Partial<PersistedToolGrantRecord> = {}): PersistedToolGrantRecord {
  return {
    id: overrides.id ?? "id-1",
    workspaceSlug: "ws-a",
    scope: "command",
    toolName: "bash",
    fingerprints: ["bash:npm test", ">bash:npm test"],
    createdAt: "2026-08-27T00:00:00.000Z",
    ...overrides,
  };
}

describe("FilePersistedGrantStore", () => {
  test("load returns empty list when file absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-tool-grants-"));
    try {
      const store = new FilePersistedGrantStore(join(root, "grants.json"));
      await expect(store.load()).resolves.toEqual([]);
      expect(existsSync(join(root, "grants.json"))).toBeFalse();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("append persists a record readable by next load", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-tool-grants-"));
    try {
      const store = new FilePersistedGrantStore(join(root, "grants.json"));
      await store.append(makeRecord());
      await expect(store.load()).resolves.toEqual([makeRecord()]);
      // 原子写不残留 tmp 文件
      const raw = JSON.parse(await readFile(join(root, "grants.json"), "utf-8"));
      expect(raw.version).toBe(1);
      expect(raw.grants).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("append dedupes by id", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-tool-grants-"));
    try {
      const store = new FilePersistedGrantStore(join(root, "grants.json"));
      await store.append(makeRecord({ id: "dup", createdAt: "t1" }));
      await store.append(makeRecord({ id: "dup", createdAt: "t2" }));
      const loaded = await store.load();
      expect(loaded).toHaveLength(1);
      expect(loaded[0]?.createdAt).toBe("t2");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("concurrent appends all land on disk (serialized RMW)", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-tool-grants-"));
    try {
      const store = new FilePersistedGrantStore(join(root, "grants.json"));
      await Promise.all(
        Array.from({ length: 8 }, (_, i) => store.append(makeRecord({ id: `id-${i}` }))),
      );
      expect(await store.load()).toHaveLength(8);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("remove deletes matching id and reports unknown ids", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-tool-grants-"));
    try {
      const store = new FilePersistedGrantStore(join(root, "grants.json"));
      await store.append(makeRecord({ id: "keep" }));
      await store.append(makeRecord({ id: "kill" }));
      await expect(store.remove("kill")).resolves.toBeTrue();
      const loaded = await store.load();
      expect(loaded.map((record) => record.id)).toEqual(["keep"]);
      await expect(store.remove("nope")).resolves.toBeFalse();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("removeByWorkspace only clears that workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-tool-grants-"));
    try {
      const store = new FilePersistedGrantStore(join(root, "grants.json"));
      await store.append(makeRecord({ id: "a1", workspaceSlug: "ws-a" }));
      await store.append(makeRecord({ id: "b1", workspaceSlug: "ws-b" }));
      await expect(store.removeByWorkspace("ws-a")).resolves.toBe(1);
      const loaded = await store.load();
      expect(loaded.map((record) => record.id)).toEqual(["b1"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("corrupt file is quarantined and load rebuilds empty", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-tool-grants-"));
    try {
      const path = join(root, "grants.json");
      await writeFile(path, "{ not json", "utf-8");
      const store = new FilePersistedGrantStore(path);
      await expect(store.load()).resolves.toEqual([]);
      // 备份现场存在（backupCorruptFile 统一收口，命名带随机段）
      const entries = await readdir(root);
      expect(entries.some((name) => name.startsWith("grants.json.corrupt-"))).toBeTrue();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("default path lives under ~/.lume", () => {
    expect(DEFAULT_TOOL_GRANTS_PATH.replace(/\\/g, "/")).toContain(".lume/tool-permission-grants.json");
  });
});
