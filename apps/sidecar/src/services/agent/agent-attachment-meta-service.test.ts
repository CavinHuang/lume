import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  deleteAttachmentMeta,
  getAttachmentMeta,
  moveAttachmentMeta,
  readThreadAttachmentMeta,
  readWorkspaceAttachmentMeta,
  upsertAttachmentMeta
} from "./agent-attachment-meta-service";
import { getAgentSessionWorkspacePath, getWorkspaceResourcesPath } from "../infra/config-paths";

const createdDirs: string[] = [];
const originalConfigDir = process.env.LUME_CONFIG_DIR;

function createTempConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lume-agent-attachment-meta-"));
  createdDirs.push(dir);
  process.env.LUME_CONFIG_DIR = dir;
  return dir;
}

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  process.env.LUME_CONFIG_DIR = originalConfigDir;
});

describe("agent-attachment-meta-service", () => {
  test("records external attachment metadata for a thread target path", () => {
    createTempConfigDir();
    const scope = { kind: "thread" as const, workspaceSlug: "ws", threadId: "thread-a" };
    const threadRoot = getAgentSessionWorkspacePath(scope.workspaceSlug, scope.threadId);
    const targetPath = join(threadRoot, "notes.txt");
    writeFileSync(targetPath, "hello", "utf-8");

    upsertAttachmentMeta(scope, targetPath, {
      label: "外部附加",
      absoluteSourcePath: "/tmp/source/notes.txt"
    });

    expect(getAttachmentMeta(scope, targetPath)).toEqual({
      label: "外部附加",
      absoluteSourcePath: "/tmp/source/notes.txt"
    });
    expect(readThreadAttachmentMeta(scope.workspaceSlug, scope.threadId)).toEqual({
      "notes.txt": {
        label: "外部附加",
        absoluteSourcePath: "/tmp/source/notes.txt"
      }
    });
  });

  test("records external attachment metadata for a workspace target path", () => {
    createTempConfigDir();
    const scope = { kind: "workspace" as const, workspaceSlug: "ws" };
    const resourcesRoot = getWorkspaceResourcesPath(scope.workspaceSlug);
    const targetPath = join(resourcesRoot, "docs", "brief.md");
    mkdirSync(join(resourcesRoot, "docs"), { recursive: true });
    writeFileSync(targetPath, "# brief", "utf-8");

    upsertAttachmentMeta(scope, targetPath, {
      label: "外部附加",
      absoluteSourcePath: "/tmp/source/brief.md"
    });

    expect(getAttachmentMeta(scope, targetPath)).toEqual({
      label: "外部附加",
      absoluteSourcePath: "/tmp/source/brief.md"
    });
    expect(readWorkspaceAttachmentMeta(scope.workspaceSlug)).toEqual({
      "docs/brief.md": {
        label: "外部附加",
        absoluteSourcePath: "/tmp/source/brief.md"
      }
    });
  });

  test("rename and move keep metadata aligned with the new target path", () => {
    createTempConfigDir();
    const scope = { kind: "thread" as const, workspaceSlug: "ws", threadId: "thread-b" };
    const threadRoot = getAgentSessionWorkspacePath(scope.workspaceSlug, scope.threadId);
    const sourceDir = join(threadRoot, "docs");
    const sourceFile = join(sourceDir, "note.txt");
    const renamedDir = join(threadRoot, "docs-renamed");
    const movedDir = join(threadRoot, "archive");
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(movedDir, { recursive: true });
    writeFileSync(sourceFile, "note", "utf-8");

    upsertAttachmentMeta(scope, sourceDir, {
      label: "外部附加",
      absoluteSourcePath: "/tmp/source/docs"
    });
    upsertAttachmentMeta(scope, sourceFile, {
      label: "外部附加",
      absoluteSourcePath: "/tmp/source/docs/note.txt"
    });

    moveAttachmentMeta(scope, sourceDir, renamedDir);
    expect(getAttachmentMeta(scope, join(renamedDir, "note.txt"))).toEqual({
      label: "外部附加",
      absoluteSourcePath: "/tmp/source/docs/note.txt"
    });

    moveAttachmentMeta(scope, renamedDir, join(movedDir, "docs-renamed"));
    expect(readThreadAttachmentMeta(scope.workspaceSlug, scope.threadId)).toEqual({
      "archive/docs-renamed": {
        label: "外部附加",
        absoluteSourcePath: "/tmp/source/docs"
      },
      "archive/docs-renamed/note.txt": {
        label: "外部附加",
        absoluteSourcePath: "/tmp/source/docs/note.txt"
      }
    });
  });

  test("delete removes stale metadata entry", () => {
    createTempConfigDir();
    const scope = { kind: "workspace" as const, workspaceSlug: "ws" };
    const resourcesRoot = getWorkspaceResourcesPath(scope.workspaceSlug);
    const dirPath = join(resourcesRoot, "assets");
    const filePath = join(dirPath, "logo.svg");
    mkdirSync(dirPath, { recursive: true });
    writeFileSync(filePath, "<svg />", "utf-8");

    upsertAttachmentMeta(scope, dirPath, {
      label: "外部附加",
      absoluteSourcePath: "/tmp/source/assets"
    });
    upsertAttachmentMeta(scope, filePath, {
      label: "外部附加",
      absoluteSourcePath: "/tmp/source/assets/logo.svg"
    });

    deleteAttachmentMeta(scope, dirPath);

    expect(readWorkspaceAttachmentMeta(scope.workspaceSlug)).toEqual({});
    expect(getAttachmentMeta(scope, filePath)).toBeUndefined();
    expect(existsSync(resourcesRoot)).toBeTrue();
  });

  test("read helpers do not create scope directories for missing metadata", () => {
    const configDir = createTempConfigDir();

    expect(readThreadAttachmentMeta("ws-read", "thread-read")).toEqual({});
    expect(readWorkspaceAttachmentMeta("ws-read")).toEqual({});

    expect(existsSync(join(configDir, "agent-workspaces", "ws-read"))).toBeFalse();
  });

  test("malformed metadata does not get silently overwritten on mutation", () => {
    createTempConfigDir();
    const scope = { kind: "thread" as const, workspaceSlug: "ws", threadId: "thread-corrupt" };
    const threadRoot = getAgentSessionWorkspacePath(scope.workspaceSlug, scope.threadId);
    const targetPath = join(threadRoot, "notes.txt");
    const metadataPath = join(threadRoot, ".context", "external-attachments.json");
    writeFileSync(targetPath, "hello", "utf-8");
    mkdirSync(join(threadRoot, ".context"), { recursive: true });
    writeFileSync(metadataPath, "{ invalid json", "utf-8");

    expect(() => upsertAttachmentMeta(scope, targetPath, {
      label: "外部附加",
      absoluteSourcePath: "/tmp/source/notes.txt"
    })).toThrow("附件元信息损坏");
    expect(readFileSync(metadataPath, "utf-8")).toBe("{ invalid json");
  });

  test("schema-invalid metadata does not get silently overwritten on mutation", () => {
    createTempConfigDir();
    const scope = { kind: "workspace" as const, workspaceSlug: "ws-schema" };
    const resourcesRoot = getWorkspaceResourcesPath(scope.workspaceSlug);
    const targetPath = join(resourcesRoot, "notes.txt");
    const metadataPath = join(resourcesRoot, "..", ".meta", "external-attachments.json");
    writeFileSync(targetPath, "hello", "utf-8");
    mkdirSync(join(resourcesRoot, "..", ".meta"), { recursive: true });
    writeFileSync(metadataPath, JSON.stringify({ "notes.txt": { attachedAt: 1 } }), "utf-8");

    expect(() => upsertAttachmentMeta(scope, targetPath, {
      label: "外部附加",
      absoluteSourcePath: "/tmp/source/notes.txt"
    })).toThrow("附件元信息损坏");
    expect(readFileSync(metadataPath, "utf-8")).toBe(JSON.stringify({ "notes.txt": { attachedAt: 1 } }));
  });

  test("move and delete do not create empty metadata files when nothing is tracked", () => {
    createTempConfigDir();
    const scope = { kind: "workspace" as const, workspaceSlug: "ws-empty" };
    const resourcesRoot = getWorkspaceResourcesPath(scope.workspaceSlug);
    const sourcePath = join(resourcesRoot, "doc.txt");
    const movedPath = join(resourcesRoot, "archive", "doc.txt");
    const metadataPath = join(resourcesRoot, "..", ".meta", "external-attachments.json");
    mkdirSync(join(resourcesRoot, "archive"), { recursive: true });
    writeFileSync(sourcePath, "hello", "utf-8");

    moveAttachmentMeta(scope, sourcePath, movedPath);
    deleteAttachmentMeta(scope, sourcePath);

    expect(existsSync(metadataPath)).toBeFalse();
  });

  test("invalid scope identifiers are rejected", () => {
    createTempConfigDir();

    expect(() => readThreadAttachmentMeta(".", "thread")).toThrow("workspaceSlug 非法");
    expect(() => readThreadAttachmentMeta("ws", "..")).toThrow("threadId 非法");
  });
});
