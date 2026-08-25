import { mkdirSync, writeFileSync } from "node:fs";
import { getRuntimeHostPorts } from "../../host-ports";
import { join } from "node:path";
import { getAgentThreadFilesPath } from "../../../infra/config-paths";
import type { FileRef } from "@lume/shared";

export interface ImageOutputInput {
  workspaceSlug?: string;
  threadId: string;
  filesRoot?: string;
  url?: string;
  b64?: string;
  ext?: string;
  abortSignal?: AbortSignal;
}

export interface ImageOutputResult {
  /** 相对线程根目录的路径（前端 READ_THREAD_FILE_DATA 据此读取） */
  threadPath: string;
  filename: string;
  mediaType: string;
  size: number;
  absPath: string;
  fileRef?: FileRef;
}

function mediaTypeFor(ext: string): string {
  const e = ext.toLowerCase();
  if (e === "jpg" || e === "jpeg") return "image/jpeg";
  if (e === "webp") return "image/webp";
  return "image/png";
}

/** 下载 URL 或解码 base64，写入线程文件目录，返回 threadPath 等元信息 */
export async function saveImageOutput(input: ImageOutputInput): Promise<ImageOutputResult> {
  const ext = (input.ext ?? "png").toLowerCase();
  const filesRoot = input.filesRoot ?? resolveFilesRoot(input.workspaceSlug, input.threadId);
  const dir = join(filesRoot, "image-gen");
  mkdirSync(dir, { recursive: true });

  const stamp = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  const filename = `${stamp}-${rand}.${ext}`;
  const absPath = join(dir, filename);

  let buffer: Buffer;
  if (input.b64) {
    buffer = Buffer.from(input.b64, "base64");
  } else if (input.url) {
    const resp = await fetch(input.url, { signal: input.abortSignal });
    if (!resp.ok) {
      throw new Error(`下载生成图片失败 ${resp.status}`);
    }
    buffer = Buffer.from(await resp.arrayBuffer());
  } else {
    throw new Error("缺少图片数据（url 或 b64）");
  }

  writeFileSync(absPath, buffer);
  const threadPath = getRuntimeHostPorts().toThreadRelativePath(input.workspaceSlug, input.threadId, absPath);
  let fileRef: FileRef | undefined;
  try {
    fileRef = { source: "session", scopeId: getRuntimeHostPorts().resolveThreadWorkdir(input.threadId).fileContextId, relativePath: threadPath };
  } catch {
    // Legacy/headless callers retain threadPath and use authorized conversion on demand.
  }
  return {
    threadPath,
    filename,
    mediaType: mediaTypeFor(ext),
    size: buffer.length,
    absPath,
    ...(fileRef ? { fileRef } : {}),
  };
}

function resolveFilesRoot(workspaceSlug: string | undefined, threadId: string): string {
  try {
    return getRuntimeHostPorts().resolveThreadWorkdir(threadId).filesRoot;
  } catch {
    if (!workspaceSlug) {
      throw new Error("无法解析普通会话文件目录");
    }
    return getAgentThreadFilesPath(workspaceSlug, threadId);
  }
}
