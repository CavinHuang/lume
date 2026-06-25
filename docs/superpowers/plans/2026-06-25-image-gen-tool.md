# Image Generation Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现真正的 `image_gen` 与 `list_image_models` 工具，读取已配置的 `models.imageGeneration.priorityModelRefs` 调用 provider 图像 API 生成/编辑图片，按优先级失败回退，结果以线程附件形式返回。

**Architecture:** 单一 OpenAI 兼容适配器 + `ImageProviderProfile` 表（openai/doubao/stepfun 同源协议，差异封进 profile）。凭证解析复用 `resolveChannelModelBinding` + `decryptApiKey`；配置读取复用 `getEffectiveLumeConfig`；图片落盘复用线程文件目录与 `toThreadRelativePath`；前端渲染复用现有线程附件机制。core 层用依赖注入便于单测。

**Tech Stack:** TypeScript（sidecar）、`bun:test`、全局 `fetch`、Node `fs`。spec：`docs/superpowers/specs/2026-06-25-image-gen-tool-design.md`。

**测试运行命令：** `cd apps/sidecar && bun test <test-file>`。类型检查：`cd apps/sidecar && bun run typecheck`。

---

## File Structure

**Create（`apps/sidecar/src/services/agent-runtime/tools/image-gen/`）:**

| 文件 | 职责 |
|---|---|
| `image-provider-profiles.ts` | `ImageProviderProfile` 接口 + provider→profile 表 + `resolveImageProviderProfile` |
| `image-gen-http.ts` | OpenAI 兼容 `/images/generations`、`/images/edits` HTTP 调用，含 abortSignal |
| `image-gen-output.ts` | 下载/解码图片 → 写入线程文件目录 → 产出 threadPath |
| `image-gen-core.ts` | 读配置→解析凭证→调用→失败回退→保存；`generateImage(params, deps?)` |
| `create-image-gen-tools.ts` | 定义 `image_gen` + `list_image_models` 工具，工具组入口 |
| `image-provider-profiles.test.ts` 等 5 个测试 | 各层 TDD 测试 |

**Modify:**
- `apps/sidecar/src/services/agent-runtime/tools/tool-metadata.ts` — 注册两个工具的元数据
- `apps/sidecar/src/services/agent-runtime/tools/create-lume-tools.ts` — 装配新工具组
- `apps/sidecar/default-skills/image-gen/SKILL.md` — 改造为引导调用真工具
- `apps/sidecar/default-skills/agent-artist/SKILL.md` — 删除"未接入"声明
- `apps/sidecar/src/services/skills/default-skills-inventory.test.ts` — 断言反转

---

## Task 1: ImageProviderProfile 表

**Files:**
- Create: `apps/sidecar/src/services/agent-runtime/tools/image-gen/image-provider-profiles.ts`
- Test: `apps/sidecar/src/services/agent-runtime/tools/image-gen/image-provider-profiles.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `image-provider-profiles.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import { resolveImageProviderProfile } from "./image-provider-profiles";

describe("image-provider-profiles", () => {
  test("openai 用默认 profile，responseFormat=b64_json", () => {
    const p = resolveImageProviderProfile("openai");
    expect(p.responseFormat).toBe("b64_json");
    expect(p.extraBody).toBeUndefined();
  });

  test("doubao 用 url 响应格式", () => {
    const p = resolveImageProviderProfile("doubao");
    expect(p.responseFormat).toBe("url");
  });

  test("stepfun 与 stepfun-coding-plan 注入特有参数", () => {
    const p = resolveImageProviderProfile("stepfun-coding-plan");
    expect(p.extraBody).toMatchObject({ steps: 8, cfg_scale: 1.0, text_mode: true });
    expect(p.extraFormFields).toMatchObject({ steps: "8", cfg_scale: "1.0", text_mode: "true" });
  });

  test("未知 provider 回退到默认 profile", () => {
    const p = resolveImageProviderProfile("ollama");
    expect(p.responseFormat).toBe("b64_json");
    expect(p.extraBody).toBeUndefined();
  });

  test("mapSize 把比例映射为像素尺寸，未命中原样返回，undefined 返回 undefined", () => {
    const p = resolveImageProviderProfile("openai");
    expect(p.mapSize?.("1:1")).toBe("1024x1024");
    expect(p.mapSize?.("16:9")).toBe("1536x1024");
    expect(p.mapSize?.("2048x2048")).toBe("2048x2048");
    expect(p.mapSize?.(undefined)).toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `cd apps/sidecar && bun test src/services/agent-runtime/tools/image-gen/image-provider-profiles.test.ts`
Expected: FAIL（模块不存在 / 导出缺失）

- [ ] **Step 3: 实现 profile 表**

创建 `image-provider-profiles.ts`：

```ts
import type { ProviderType } from "@lume/shared";

export type ImageGenMode = "text-to-image" | "image-to-image" | "edit";
export type ImageResponseFormat = "url" | "b64_json";

export interface ImageProviderProfile {
  /** 请求 response_format 与响应解析依据 */
  responseFormat: ImageResponseFormat;
  /** 把通用 size（1:1/16:9/像素）映射为 provider 支持尺寸；返回 undefined 表示不发送 size */
  mapSize?: (size?: string) => string | undefined;
  /** 文生图 JSON body 的 provider 特有参数（原始类型） */
  extraBody?: Record<string, unknown>;
  /** 编辑 multipart 的 provider 特有字段（字符串值） */
  extraFormFields?: Record<string, string>;
  /** 编辑模式参考图字段名，默认 "image" */
  editImageField?: string;
  /** 编辑模式蒙版字段名，默认 "mask" */
  editMaskField?: string;
}

const DEFAULT_SIZE_MAP: Record<string, string> = {
  "1:1": "1024x1024",
  "16:9": "1536x1024",
  "9:16": "1024x1536",
  "3:4": "1024x1536",
  "4:3": "1536x1024",
};

function defaultMapSize(size?: string): string | undefined {
  if (!size) return undefined;
  return DEFAULT_SIZE_MAP[size] ?? size;
}

const OPENAI_PROFILE: ImageProviderProfile = {
  responseFormat: "b64_json",
  mapSize: defaultMapSize,
};

const DOUBAO_PROFILE: ImageProviderProfile = {
  responseFormat: "url",
  mapSize: defaultMapSize,
};

const STEPFUN_PROFILE: ImageProviderProfile = {
  responseFormat: "b64_json",
  mapSize: defaultMapSize,
  extraBody: { steps: 8, cfg_scale: 1.0, text_mode: true },
  extraFormFields: { steps: "8", cfg_scale: "1.0", text_mode: "true" },
};

const PROFILE_BY_PROVIDER: Partial<Record<ProviderType, ImageProviderProfile>> = {
  openai: OPENAI_PROFILE,
  doubao: DOUBAO_PROFILE,
  stepfun: STEPFUN_PROFILE,
  "stepfun-coding-plan": STEPFUN_PROFILE,
};

/** 按 provider 取 profile；未知 provider 回退到 OpenAI 默认 */
export function resolveImageProviderProfile(provider: ProviderType): ImageProviderProfile {
  return PROFILE_BY_PROVIDER[provider] ?? OPENAI_PROFILE;
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `cd apps/sidecar && bun test src/services/agent-runtime/tools/image-gen/image-provider-profiles.test.ts`
Expected: PASS（5 个用例全过）

- [ ] **Step 5: Commit**

```bash
git add apps/sidecar/src/services/agent-runtime/tools/image-gen/image-provider-profiles.ts apps/sidecar/src/services/agent-runtime/tools/image-gen/image-provider-profiles.test.ts
git commit -m "✨ feat(sidecar): 图像生成 provider profile 表"
```

---

## Task 2: image-gen-http（OpenAI 兼容 HTTP 调用）

**Files:**
- Create: `apps/sidecar/src/services/agent-runtime/tools/image-gen/image-gen-http.ts`
- Test: `apps/sidecar/src/services/agent-runtime/tools/image-gen/image-gen-http.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `image-gen-http.test.ts`：

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { callImageHttp } from "./image-gen-http";
import { resolveImageProviderProfile } from "./image-provider-profiles";

const originalFetch = globalThis.fetch;

function mockFetchJson(handler: (url: string, init: RequestInit) => unknown | Promise<unknown>) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const body = await handler(url, init ?? {});
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

function mockFetchStatus(status: number, text: string) {
  globalThis.fetch = (async () =>
    new Response(text, { status, statusText: text })) as unknown as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("image-gen-http", () => {
  test("文生图：POST {baseUrl}/images/generations，JSON body 含 model/prompt/response_format", async () => {
    let captured: { url: string; body: any } = { url: "", body: {} };
    mockFetchJson((url, init) => {
      captured = { url, body: JSON.parse(String(init.body)) };
      return { data: [{ b64_json: "AAAA" }] };
    });

    const result = await callImageHttp({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      model: "gpt-image-1",
      mode: "text-to-image",
      prompt: "a cat",
      size: "1:1",
      profile: resolveImageProviderProfile("openai"),
    });

    expect(captured.url).toBe("https://api.openai.com/v1/images/generations");
    expect(captured.body).toMatchObject({
      model: "gpt-image-1",
      prompt: "a cat",
      response_format: "b64_json",
      size: "1024x1024",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.b64).toBe("AAAA");
  });

  test("豆包 baseUrl 直接拼接（保留 /api/v3），response_format=url", async () => {
    let capturedUrl = "";
    mockFetchJson((url) => {
      capturedUrl = url;
      return { data: [{ url: "https://ark.example.com/img.png" }] };
    });

    const result = await callImageHttp({
      baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      apiKey: "ark-key",
      model: "seedream-3-0-t2i",
      mode: "text-to-image",
      prompt: "x",
      profile: resolveImageProviderProfile("doubao"),
    });

    expect(capturedUrl).toBe("https://ark.cn-beijing.volces.com/api/v3/images/generations");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.url).toBe("https://ark.example.com/img.png");
  });

  test("StepFun 注入 extraBody 特有参数", async () => {
    let body: any = {};
    mockFetchJson((_url, init) => {
      body = JSON.parse(String(init.body));
      return { data: [{ b64_json: "BBBB" }] };
    });

    await callImageHttp({
      baseUrl: "https://api.stepfun.com/step_plan/v1",
      apiKey: "step-key",
      model: "step-image-edit-2",
      mode: "text-to-image",
      prompt: "x",
      profile: resolveImageProviderProfile("stepfun-coding-plan"),
    });

    expect(body).toMatchObject({ steps: 8, cfg_scale: 1.0, text_mode: true });
  });

  test("非 2xx 抛错（触发回退）", async () => {
    mockFetchStatus(429, "rate limited");
    await expect(
      callImageHttp({
        baseUrl: "https://api.openai.com/v1",
        apiKey: "k",
        model: "gpt-image-1",
        mode: "text-to-image",
        prompt: "x",
        profile: resolveImageProviderProfile("openai"),
      }),
    ).rejects.toThrow(/429/);
  });

  test("响应缺 data 抛错", async () => {
    mockFetchJson(() => ({ error: "bad" }));
    await expect(
      callImageHttp({
        baseUrl: "https://api.openai.com/v1",
        apiKey: "k",
        model: "gpt-image-1",
        mode: "text-to-image",
        prompt: "x",
        profile: resolveImageProviderProfile("openai"),
      }),
    ).rejects.toThrow(/缺少 data/);
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `cd apps/sidecar && bun test src/services/agent-runtime/tools/image-gen/image-gen-http.test.ts`
Expected: FAIL（`callImageHttp` 不存在）

- [ ] **Step 3: 实现 http 调用**

创建 `image-gen-http.ts`：

```ts
import { readFile } from "node:fs/promises";
import type { ImageGenMode, ImageProviderProfile } from "./image-provider-profiles";

export interface ImageHttpInput {
  baseUrl: string;
  apiKey: string;
  model: string;
  mode: ImageGenMode;
  prompt: string;
  size?: string;
  profile: ImageProviderProfile;
  referenceImageAbsPath?: string;
  maskImageAbsPath?: string;
  abortSignal?: AbortSignal;
}

export interface ImageHttpSuccess {
  ok: true;
  url?: string;
  b64?: string;
  ext: string;
}

function joinImageUrl(baseUrl: string, suffix: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${suffix}`;
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return response.statusText;
  }
}

/** 调用 OpenAI 兼容图像接口。成功返回图片数据，失败抛错（由 core 层捕获做回退） */
export async function callImageHttp(input: ImageHttpInput): Promise<ImageHttpSuccess> {
  const endpoint = input.mode === "text-to-image" ? "/images/generations" : "/images/edits";
  const url = joinImageUrl(input.baseUrl, endpoint);
  const headers: Record<string, string> = { Authorization: `Bearer ${input.apiKey}` };

  let response: Response;
  if (input.mode === "text-to-image") {
    headers["Content-Type"] = "application/json";
    const body: Record<string, unknown> = {
      model: input.model,
      prompt: input.prompt,
      response_format: input.profile.responseFormat,
      ...input.profile.extraBody,
    };
    const mappedSize = input.profile.mapSize?.(input.size);
    if (mappedSize) body.size = mappedSize;
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: input.abortSignal,
    });
  } else {
    if (!input.referenceImageAbsPath) {
      throw new Error("图生图/编辑模式缺少 referenceImageAbsPath");
    }
    const form = new FormData();
    const imageField = input.profile.editImageField ?? "image";
    const maskField = input.profile.editMaskField ?? "mask";
    form.append("model", input.model);
    form.append("prompt", input.prompt);
    form.append("response_format", input.profile.responseFormat);
    const mappedSize = input.profile.mapSize?.(input.size);
    if (mappedSize) form.append("size", mappedSize);
    form.append(imageField, new Blob([await readFile(input.referenceImageAbsPath)]));
    if (input.maskImageAbsPath) {
      form.append(maskField, new Blob([await readFile(input.maskImageAbsPath)]));
    }
    for (const [k, v] of Object.entries(input.profile.extraFormFields ?? {})) {
      form.append(k, v);
    }
    response = await fetch(url, { method: "POST", headers, body: form, signal: input.abortSignal });
  }

  if (!response.ok) {
    const text = await safeReadText(response);
    throw new Error(`图像生成请求失败 ${response.status}: ${text}`);
  }

  const json = (await response.json()) as { data?: Array<{ url?: string; b64_json?: string }> };
  const item = json.data?.[0];
  if (!item) {
    throw new Error("图像生成响应缺少 data");
  }
  if (item.b64_json) return { ok: true, b64: item.b64_json, ext: "png" };
  if (item.url) return { ok: true, url: item.url, ext: "png" };
  throw new Error("图像生成响应缺少图片数据");
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `cd apps/sidecar && bun test src/services/agent-runtime/tools/image-gen/image-gen-http.test.ts`
Expected: PASS（5 个用例全过）

- [ ] **Step 5: Commit**

```bash
git add apps/sidecar/src/services/agent-runtime/tools/image-gen/image-gen-http.ts apps/sidecar/src/services/agent-runtime/tools/image-gen/image-gen-http.test.ts
git commit -m "✨ feat(sidecar): 图像生成 OpenAI 兼容 HTTP 调用"
```

---

## Task 3: image-gen-output（保存图片到线程文件）

**Files:**
- Create: `apps/sidecar/src/services/agent-runtime/tools/image-gen/image-gen-output.ts`
- Test: `apps/sidecar/src/services/agent-runtime/tools/image-gen/image-gen-output.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `image-gen-output.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveImageOutput } from "./image-gen-output";

const originalFetch = globalThis.fetch;
let prevConfigDir: string | undefined;
let tempConfigDir = "";

beforeEach(() => {
  prevConfigDir = process.env.LUME_CONFIG_DIR;
  tempConfigDir = mkdtempSync(join(tmpdir(), "lume-img-out-"));
  process.env.LUME_CONFIG_DIR = tempConfigDir;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (prevConfigDir === undefined) delete process.env.LUME_CONFIG_DIR;
  else process.env.LUME_CONFIG_DIR = prevConfigDir;
  if (tempConfigDir) rmSync(tempConfigDir, { recursive: true, force: true });
});

describe("image-gen-output", () => {
  test("b64 解码后写入线程 files/image-gen 目录，返回相对线程根的 threadPath", async () => {
    const result = await saveImageOutput({
      workspaceSlug: "ws",
      threadId: "thread-1",
      b64: Buffer.from("fake-png-bytes").toString("base64"),
      ext: "png",
    });

    expect(result.threadPath).toMatch(/^files\/image-gen\/.+\.png$/);
    expect(result.mediaType).toBe("image/png");
    expect(result.size).toBeGreaterThan(0);
    expect(existsSync(result.absPath)).toBe(true);
    expect(readFileSync(result.absPath).toString()).toBe("fake-png-bytes");
  });

  test("url 下载后写入文件", async () => {
    globalThis.fetch = (async () =>
      new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { status: 200 })) as unknown as typeof fetch;

    const result = await saveImageOutput({
      workspaceSlug: "ws",
      threadId: "thread-2",
      url: "https://example.com/x.png",
    });

    expect(result.threadPath).toMatch(/^files\/image-gen\/.+\.png$/);
    expect(result.size).toBe(4);
  });

  test("缺少 url 与 b64 抛错", async () => {
    await expect(
      saveImageOutput({ workspaceSlug: "ws", threadId: "thread-3" }),
    ).rejects.toThrow(/缺少图片数据/);
  });

  test("jpg 扩展名映射为 image/jpeg", async () => {
    const result = await saveImageOutput({
      workspaceSlug: "ws",
      threadId: "thread-4",
      b64: Buffer.from("x").toString("base64"),
      ext: "jpg",
    });
    expect(result.mediaType).toBe("image/jpeg");
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `cd apps/sidecar && bun test src/services/agent-runtime/tools/image-gen/image-gen-output.test.ts`
Expected: FAIL（`saveImageOutput` 不存在）

- [ ] **Step 3: 实现输出保存**

创建 `image-gen-output.ts`：

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentThreadFilesPath } from "../../../infra/config-paths";
import { toThreadRelativePath } from "../../../agent/agent-files-service";

export interface ImageOutputInput {
  workspaceSlug: string;
  threadId: string;
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
  const dir = join(getAgentThreadFilesPath(input.workspaceSlug, input.threadId), "image-gen");
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
  const threadPath = toThreadRelativePath(input.workspaceSlug, input.threadId, absPath);
  return {
    threadPath,
    filename,
    mediaType: mediaTypeFor(ext),
    size: buffer.length,
    absPath,
  };
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `cd apps/sidecar && bun test src/services/agent-runtime/tools/image-gen/image-gen-output.test.ts`
Expected: PASS（4 个用例全过）

- [ ] **Step 5: Commit**

```bash
git add apps/sidecar/src/services/agent-runtime/tools/image-gen/image-gen-output.ts apps/sidecar/src/services/agent-runtime/tools/image-gen/image-gen-output.test.ts
git commit -m "✨ feat(sidecar): 图像生成结果保存为线程附件"
```

---

## Task 4: image-gen-core（配置读取 + 凭证解析 + 失败回退）

**Files:**
- Create: `apps/sidecar/src/services/agent-runtime/tools/image-gen/image-gen-core.ts`
- Test: `apps/sidecar/src/services/agent-runtime/tools/image-gen/image-gen-core.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `image-gen-core.test.ts`（用依赖注入 mock，纯逻辑、无 IO）：

```ts
import { describe, expect, test } from "bun:test";
import { generateImage, type ImageGenDeps } from "./image-gen-core";
import type { Channel } from "@lume/shared";

function makeChannel(provider: string): Channel {
  return {
    id: `ch-${provider}`,
    name: provider,
    provider: provider as any,
    baseUrl: `https://${provider}.example/v1`,
    apiKey: "encrypted",
    models: [],
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  };
}

function makeDeps(overrides: Partial<ImageGenDeps> = {}): ImageGenDeps {
  return {
    resolveBinding: () => ({ channel: makeChannel("openai"), modelId: "gpt-image-1" }),
    decryptKey: () => "decrypted-key",
    readModelRefs: () => ["openai/gpt-image-1"],
    resolveRef: () => "/tmp/ref.png",
    callHttp: async () => ({ ok: true as const, b64: "AAAA", ext: "png" }),
    saveOutput: async () => ({
      threadPath: "files/image-gen/x.png",
      filename: "x.png",
      mediaType: "image/png",
      size: 10,
      absPath: "/tmp/x.png",
    }),
    ...overrides,
  };
}

describe("image-gen-core", () => {
  test("未配置模型时抛错", async () => {
    const deps = makeDeps({ readModelRefs: () => [] });
    await expect(
      generateImage({ workspaceSlug: "ws", threadId: "t", prompt: "x" }, deps),
    ).rejects.toThrow(/未配置图像生成模型/);
  });

  test("主模型成功，modelUsed 为主模型", async () => {
    const result = await generateImage(
      { workspaceSlug: "ws", threadId: "t", prompt: "x" },
      makeDeps(),
    );
    expect(result.modelUsed).toBe("openai/gpt-image-1");
    expect(result.mode).toBe("text-to-image");
    expect(result.images[0]?.threadPath).toBe("files/image-gen/x.png");
  });

  test("主模型失败，回退到第二个模型", async () => {
    const callHttp = makeDeps().callHttp;
    let n = 0;
    const deps = makeDeps({
      readModelRefs: () => ["doubao/seedream", "openai/gpt-image-1"],
      callHttp: async (input) => {
        n++;
        if (n === 1) throw new Error("429");
        return { ok: true as const, url: "https://x/img.png", ext: "png" };
      },
    });
    const result = await generateImage({ workspaceSlug: "ws", threadId: "t", prompt: "x" }, deps);
    expect(result.modelUsed).toBe("openai/gpt-image-1");
  });

  test("全部失败时抛聚合错误，含每个 modelRef", async () => {
    const deps = makeDeps({
      readModelRefs: () => ["doubao/seedream", "openai/gpt-image-1"],
      callHttp: async () => { throw new Error("boom"); },
    });
    await expect(
      generateImage({ workspaceSlug: "ws", threadId: "t", prompt: "x" }, deps),
    ).rejects.toThrow(/doubao\/seedream: boom.*openai\/gpt-image-1: boom/);
  });

  test("渠道未配置/未启用的 modelRef 记为失败并继续", async () => {
    let calledFor: string | undefined;
    const deps = makeDeps({
      readModelRefs: () => ["ollama/missing", "openai/gpt-image-1"],
      resolveBinding: (ref) =>
        ref === "ollama/missing" ? null : { channel: makeChannel("openai"), modelId: "gpt-image-1" },
      callHttp: async (input) => {
        calledFor = input.model;
        return { ok: true as const, b64: "AAAA", ext: "png" };
      },
    });
    const result = await generateImage({ workspaceSlug: "ws", threadId: "t", prompt: "x" }, deps);
    expect(result.modelUsed).toBe("openai/gpt-image-1");
    expect(calledFor).toBe("gpt-image-1");
  });

  test("显式 model 优先，且去重后仍回退", async () => {
    const order: string[] = [];
    const deps = makeDeps({
      readModelRefs: () => ["openai/gpt-image-1"],
      resolveBinding: (ref) => {
        order.push(ref);
        return { channel: makeChannel("openai"), modelId: ref.split("/")[1] ?? ref };
      },
      callHttp: async (input) => {
        if (input.model === "explicit") throw new Error("fail");
        return { ok: true as const, b64: "AAAA", ext: "png" };
      },
    });
    const result = await generateImage(
      { workspaceSlug: "ws", threadId: "t", prompt: "x", model: "openai/explicit" },
      deps,
    );
    expect(order[0]).toBe("openai/explicit");
    expect(result.modelUsed).toBe("openai/gpt-image-1");
  });

  test("reference_image 存在 → 模式为 image-to-image", async () => {
    const deps = makeDeps();
    const result = await generateImage(
      { workspaceSlug: "ws", threadId: "t", prompt: "x", referenceImage: "files/ref.png" },
      deps,
    );
    expect(result.mode).toBe("image-to-image");
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `cd apps/sidecar && bun test src/services/agent-runtime/tools/image-gen/image-gen-core.test.ts`
Expected: FAIL（`generateImage` 不存在）

- [ ] **Step 3: 实现 core**

创建 `image-gen-core.ts`：

```ts
import type { Channel, ProviderType } from "@lume/shared";
import { decryptApiKey, resolveChannelModelBinding } from "../../../channel/channel-manager";
import { getEffectiveLumeConfig } from "../../../system/lume-config-service";
import { resolveThreadAttachmentPath } from "../../../agent/agent-files-service";
import { createLogger } from "../../../infra/logger";
import { callImageHttp } from "./image-gen-http";
import { saveImageOutput } from "./image-gen-output";
import { resolveImageProviderProfile, type ImageGenMode } from "./image-provider-profiles";

const log = createLogger("image-gen");

export interface ImageGenImage {
  threadPath: string;
  filename: string;
  mediaType: string;
  size: number;
}

export interface ImageGenResult {
  images: ImageGenImage[];
  modelUsed: string;
  mode: ImageGenMode;
}

export interface ImageGenParams {
  workspaceSlug: string;
  threadId: string;
  prompt: string;
  size?: string;
  referenceImage?: string;
  maskImage?: string;
  model?: string;
  abortSignal?: AbortSignal;
}

export interface ImageGenDeps {
  resolveBinding: (modelRef: string) => { channel: Channel; modelId: string } | null;
  decryptKey: (channelId: string) => string;
  callHttp: typeof callImageHttp;
  readModelRefs: (workspaceSlug?: string) => string[];
  resolveRef: (workspaceSlug: string, threadId: string, threadPath: string) => string;
  saveOutput: typeof saveImageOutput;
}

const defaultDeps: ImageGenDeps = {
  resolveBinding: (modelRef) => {
    const binding = resolveChannelModelBinding(modelRef);
    return binding ? { channel: binding.channel, modelId: binding.modelId } : null;
  },
  decryptKey: decryptApiKey,
  callHttp: callImageHttp,
  readModelRefs: (ws) =>
    getEffectiveLumeConfig(ws).models?.imageGeneration?.priorityModelRefs ?? [],
  resolveRef: resolveThreadAttachmentPath,
  saveOutput: saveImageOutput,
};

function resolveMode(referenceImage?: string, maskImage?: string): ImageGenMode {
  if (referenceImage && maskImage) return "edit";
  if (referenceImage) return "image-to-image";
  return "text-to-image";
}

/** 按优先级尝试生成；成功即返回，全部失败抛聚合错误 */
export async function generateImage(
  params: ImageGenParams,
  deps: ImageGenDeps = defaultDeps,
): Promise<ImageGenResult> {
  const mode = resolveMode(params.referenceImage, params.maskImage);

  const refs = deps.readModelRefs(params.workspaceSlug);
  if (refs.length === 0) {
    throw new Error("未配置图像生成模型（请在设置中配置 models.imageGeneration.priorityModelRefs）");
  }

  const ordered = params.model
    ? Array.from(new Set([params.model, ...refs]))
    : refs;

  let referenceAbsPath: string | undefined;
  let maskAbsPath: string | undefined;
  if (params.referenceImage) {
    referenceAbsPath = deps.resolveRef(params.workspaceSlug, params.threadId, params.referenceImage);
  }
  if (params.maskImage) {
    maskAbsPath = deps.resolveRef(params.workspaceSlug, params.threadId, params.maskImage);
  }

  const failures: Array<{ modelRef: string; error: string }> = [];
  for (const modelRef of ordered) {
    const binding = deps.resolveBinding(modelRef);
    if (!binding) {
      failures.push({ modelRef, error: "渠道未配置或未启用" });
      continue;
    }
    const apiKey = deps.decryptKey(binding.channel.id);
    const provider = (binding.channel.providerId ?? binding.channel.provider) as ProviderType;
    const profile = resolveImageProviderProfile(provider);
    try {
      const httpResult = await deps.callHttp({
        baseUrl: binding.channel.baseUrl,
        apiKey,
        model: binding.modelId,
        mode,
        prompt: params.prompt,
        size: params.size,
        profile,
        referenceImageAbsPath: referenceAbsPath,
        maskImageAbsPath: maskAbsPath,
        abortSignal: params.abortSignal,
      });
      const saved = await deps.saveOutput({
        workspaceSlug: params.workspaceSlug,
        threadId: params.threadId,
        url: httpResult.url,
        b64: httpResult.b64,
        ext: httpResult.ext,
        abortSignal: params.abortSignal,
      });
      log.info("图像生成成功", { modelRef, mode, threadPath: saved.threadPath });
      return {
        images: [{
          threadPath: saved.threadPath,
          filename: saved.filename,
          mediaType: saved.mediaType,
          size: saved.size,
        }],
        modelUsed: modelRef,
        mode,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn("图像生成失败，尝试下一个模型", { modelRef, message });
      failures.push({ modelRef, error: message });
    }
  }

  const detail = failures.map((f) => `${f.modelRef}: ${f.error}`).join("; ");
  throw new Error(`所有图像生成模型均失败 — ${detail}`);
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `cd apps/sidecar && bun test src/services/agent-runtime/tools/image-gen/image-gen-core.test.ts`
Expected: PASS（7 个用例全过）

- [ ] **Step 5: Commit**

```bash
git add apps/sidecar/src/services/agent-runtime/tools/image-gen/image-gen-core.ts apps/sidecar/src/services/agent-runtime/tools/image-gen/image-gen-core.test.ts
git commit -m "✨ feat(sidecar): 图像生成核心（配置/凭证/回退）"
```

---

## Task 5: create-image-gen-tools（工具定义）

**Files:**
- Create: `apps/sidecar/src/services/agent-runtime/tools/image-gen/create-image-gen-tools.ts`
- Test: `apps/sidecar/src/services/agent-runtime/tools/image-gen/create-image-gen-tools.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `create-image-gen-tools.test.ts`：

```ts
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createImageGenTools } from "./create-image-gen-tools";

let prevConfigDir: string | undefined;
let tempConfigDir = "";

beforeEach(() => {
  prevConfigDir = process.env.LUME_CONFIG_DIR;
  tempConfigDir = mkdtempSync(join(tmpdir(), "lume-img-tools-"));
  process.env.LUME_CONFIG_DIR = tempConfigDir;
  // 写入空 lume.yaml（list_image_models 默认无模型）
  writeFileSync(join(tempConfigDir, "lume.yaml"), "version: 1\n");
});

describe("create-image-gen-tools", () => {
  test("注册 image_gen 与 list_image_models 两个工具", () => {
    const tools = createImageGenTools({ threadId: "t", workspaceSlug: "ws" });
    const names = tools.map((t) => t.name);
    expect(names).toContain("image_gen");
    expect(names).toContain("list_image_models");
  });

  test("image_gen 缺 prompt 报错", async () => {
    const tools = createImageGenTools({ threadId: "t", workspaceSlug: "ws" });
    const tool = tools.find((t) => t.name === "image_gen")!;
    const result = await tool.call({}, { cwd: "/tmp" } as never);
    expect(result).toMatchObject({ type: "tool_result", is_error: true });
    expect(String(result.content)).toContain("prompt");
  });

  test("image_gen 仅传 mask_image（无 reference_image）报错", async () => {
    const tools = createImageGenTools({ threadId: "t", workspaceSlug: "ws" });
    const tool = tools.find((t) => t.name === "image_gen")!;
    const result = await tool.call(
      { prompt: "x", mask_image: "files/m.png" },
      { cwd: "/tmp" } as never,
    );
    expect(result).toMatchObject({ type: "tool_result", is_error: true });
    expect(String(result.content)).toContain("mask_image");
  });

  test("image_gen 未配置模型时报错", async () => {
    const tools = createImageGenTools({ threadId: "t", workspaceSlug: "ws" });
    const tool = tools.find((t) => t.name === "image_gen")!;
    const result = await tool.call({ prompt: "a cat" }, { cwd: "/tmp" } as never);
    expect(result).toMatchObject({ type: "tool_result", is_error: true });
    expect(String(result.content)).toContain("未配置");
  });

  test("list_image_models 返回空模型列表（未配置）", async () => {
    const tools = createImageGenTools({ threadId: "t", workspaceSlug: "ws" });
    const tool = tools.find((t) => t.name === "list_image_models")!;
    const result = await tool.call({}, { cwd: "/tmp" } as never);
    const parsed = JSON.parse(String(result.content));
    expect(parsed.data.models).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `cd apps/sidecar && bun test src/services/agent-runtime/tools/image-gen/create-image-gen-tools.test.ts`
Expected: FAIL（`createImageGenTools` 不存在）

- [ ] **Step 3: 实现工具**

创建 `create-image-gen-tools.ts`：

```ts
import type { ToolDefinition } from "@lume/agent-sdk";
import { resolveChannelModelBinding } from "../../../channel/channel-manager";
import { getEffectiveLumeConfig } from "../../../system/lume-config-service";
import { createSdkJsonResultTool } from "../sdk-tool-result";
import { generateImage } from "./image-gen-core";

export interface CreateImageGenToolsInput {
  threadId: string;
  workspaceSlug?: string;
}

export function createImageGenTools(input: CreateImageGenToolsInput): ToolDefinition[] {
  return [
    createSdkJsonResultTool({
      name: "image_gen",
      description: `Generate an image from a text prompt, or transform/edit a reference image. The model is chosen automatically from the configured image-generation priority list, with automatic fallback on failure.

Modes (decided by which inputs you provide):
- text-to-image: prompt only (+ optional size)
- image-to-image: prompt + reference_image
- edit/inpaint: prompt + reference_image + mask_image

reference_image and mask_image accept a threadPath (relative to the current thread). The generated image is saved to the current thread; the returned threadPath can be referenced in your reply so the user can preview it.`,
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Image generation prompt. English recommended.", minLength: 1 },
          size: { type: "string", description: 'Size or aspect ratio, e.g. "1024x1024", "1:1", "16:9". Optional.' },
          reference_image: { type: "string", description: "threadPath of a reference image for image-to-image or edit." },
          mask_image: { type: "string", description: "threadPath of a mask marking the region to repaint. Requires reference_image." },
          model: { type: "string", description: "Optional explicit modelRef overriding the automatic priority list." },
        },
        required: ["prompt"],
      },
      async call(args) {
        const workspaceSlug = input.workspaceSlug;
        if (!workspaceSlug) {
          throw new Error("image_gen 需要工作区上下文");
        }
        const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
        if (!prompt) {
          throw new Error("prompt 必填");
        }
        const referenceImage = typeof args.reference_image === "string" && args.reference_image.trim() ? args.reference_image.trim() : undefined;
        const maskImage = typeof args.mask_image === "string" && args.mask_image.trim() ? args.mask_image.trim() : undefined;
        if (maskImage && !referenceImage) {
          throw new Error("mask_image 必须与 reference_image 同时提供");
        }
        const size = typeof args.size === "string" && args.size.trim() ? args.size.trim() : undefined;
        const model = typeof args.model === "string" && args.model.trim() ? args.model.trim() : undefined;

        return generateImage({
          workspaceSlug,
          threadId: input.threadId,
          prompt,
          size,
          referenceImage,
          maskImage,
          model,
        });
      },
    }),
    createSdkJsonResultTool({
      name: "list_image_models",
      description: "List the configured image-generation models with their availability. Use this to tell the user which image models are available, or to pick a specific model for image_gen.",
      inputSchema: { type: "object", properties: {} },
      isReadOnly: true,
      async call() {
        const config = getEffectiveLumeConfig(input.workspaceSlug);
        const refs = config.models?.imageGeneration?.priorityModelRefs ?? [];
        const models = refs.map((modelRef, index) => {
          const binding = resolveChannelModelBinding(modelRef);
          if (!binding) {
            return { modelRef, provider: null, modelId: null, available: false, reason: "渠道未配置或未启用", priority: index + 1 };
          }
          return {
            modelRef,
            provider: binding.channel.providerId ?? binding.channel.provider,
            modelId: binding.modelId,
            available: true,
            priority: index + 1,
          };
        });
        return { models };
      },
    }),
  ];
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `cd apps/sidecar && bun test src/services/agent-runtime/tools/image-gen/create-image-gen-tools.test.ts`
Expected: PASS（5 个用例全过）

- [ ] **Step 5: Commit**

```bash
git add apps/sidecar/src/services/agent-runtime/tools/image-gen/create-image-gen-tools.ts apps/sidecar/src/services/agent-runtime/tools/image-gen/create-image-gen-tools.test.ts
git commit -m "✨ feat(sidecar): image_gen 与 list_image_models 工具定义"
```

---

## Task 6: 工具元数据注册 + 装配进 create-lume-tools

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/tools/tool-metadata.ts`（在注册区追加）
- Modify: `apps/sidecar/src/services/agent-runtime/tools/create-lume-tools.ts`（装配）
- Test: `apps/sidecar/src/services/agent-runtime/tools/create-image-gen-tools-wiring.test.ts`（新建）

- [ ] **Step 1: 写失败测试**

创建 `create-image-gen-tools-wiring.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getToolMetadata } from "../tool-metadata";
import { createLumeRuntimeTools } from "../create-lume-tools";

let prevConfigDir: string | undefined;
let tempConfigDir = "";

beforeEach(() => {
  prevConfigDir = process.env.LUME_CONFIG_DIR;
  tempConfigDir = mkdtempSync(join(tmpdir(), "lume-img-wiring-"));
  process.env.LUME_CONFIG_DIR = tempConfigDir;
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.LUME_CONFIG_DIR;
  else process.env.LUME_CONFIG_DIR = prevConfigDir;
  if (tempConfigDir) rmSync(tempConfigDir, { recursive: true, force: true });
});

describe("image-gen wiring", () => {
  test("image_gen 元数据为 execute/medium，plan 模式禁用", () => {
    expect(getToolMetadata("image_gen")).toMatchObject({
      category: "execute",
      riskLevel: "medium",
      allowedInPlanMode: false,
    });
  });

  test("list_image_models 元数据为 read/low，plan 模式允许", () => {
    expect(getToolMetadata("list_image_models")).toMatchObject({
      category: "read",
      riskLevel: "low",
      allowedInPlanMode: true,
    });
  });

  test("createLumeRuntimeTools 装配两个工具并加入 availableToolNames", () => {
    const { customTools, availableToolNames } = createLumeRuntimeTools({
      threadId: "t",
      workspaceSlug: "ws",
      includeCitations: false,
      emitAskUserQuestion: () => {},
      emitToolPermissionRequest: () => {},
    });
    expect(customTools.map((t) => t.name)).toContain("image_gen");
    expect(customTools.map((t) => t.name)).toContain("list_image_models");
    expect(availableToolNames).toContain("image_gen");
    expect(availableToolNames).toContain("list_image_models");
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `cd apps/sidecar && bun test src/services/agent-runtime/tools/create-image-gen-tools-wiring.test.ts`
Expected: FAIL（元数据未注册、工具未装配）

- [ ] **Step 3: 注册工具元数据**

在 `tool-metadata.ts` 的注册区（任意 `registerToolMetadata({...})` 之后，例如最后一个注册项后）追加：

```ts
registerToolMetadata({
  name: "image_gen",
  category: "execute",
  riskLevel: "medium",
  description: "调用配置的图像生成模型生成或编辑图片"
});

registerToolMetadata({
  name: "list_image_models",
  category: "read",
  riskLevel: "low",
  description: "列出已配置的图像生成模型及可用性"
});
```

- [ ] **Step 4: 装配进 create-lume-tools**

在 `create-lume-tools.ts`：
- 顶部 import 区追加 `import { createImageGenTools } from "./image-gen/create-image-gen-tools";`
- 在 `createLumeRuntimeTools` 函数内（其他 `const xxxTools = ...` 之后、`const customTools = [...]` 之前）追加：

```ts
  const imageGenTools = createImageGenTools({
    threadId: input.threadId,
    workspaceSlug: input.workspaceSlug,
  });
```

- 在 `customTools` 数组中追加 `...imageGenTools,`（与其他工具组并列，例如在 `...routineTools,` 之后）。

- [ ] **Step 5: 运行测试验证通过**

Run: `cd apps/sidecar && bun test src/services/agent-runtime/tools/create-image-gen-tools-wiring.test.ts`
Expected: PASS（3 个用例全过）

- [ ] **Step 6: 类型检查 + Commit**

Run: `cd apps/sidecar && bun run typecheck`
Expected: 无错误

```bash
git add apps/sidecar/src/services/agent-runtime/tools/tool-metadata.ts apps/sidecar/src/services/agent-runtime/tools/create-lume-tools.ts apps/sidecar/src/services/agent-runtime/tools/create-image-gen-tools-wiring.test.ts
git commit -m "✨ feat(sidecar): 注册图像生成工具元数据并装配"
```

---

## Task 7: 改造占位 Skill + 反转 inventory 测试

**Files:**
- Modify: `apps/sidecar/default-skills/image-gen/SKILL.md`
- Modify: `apps/sidecar/default-skills/agent-artist/SKILL.md`
- Modify: `apps/sidecar/src/services/skills/default-skills-inventory.test.ts`

- [ ] **Step 1: 改造 image-gen SKILL.md**

把 `apps/sidecar/default-skills/image-gen/SKILL.md` 整体替换为：

```markdown
---
name: "图片生成"
description: "使用 image_gen 工具生成或编辑图片，并把生成的图片展示给用户"
when_to_use: "当用户说生成图片、画一张、AI 画图、文生图、垫图、参考这张图改风格、做海报/插画/视觉稿时使用"
allowed_tools: ["image_gen", "list_image_models"]
version: "0.2"
---

## 图片生成

你是 Lume 的图片生成助手，负责把用户的视觉需求转化为 `image_gen` 工具调用，生成真实图片并展示给用户。

### 工作流程

1. 提取用户需求：主体、用途、风格、构图、色调、比例、是否有参考图。
2. 整理成清晰的英文提示词（prompt）。
3. 调用工具：
   - 文生图：`image_gen`，传入 `prompt`（与可选 `size`）。
   - 参考图改风格/垫图：`image_gen`，传入 `prompt` 与 `reference_image`（参考图的 threadPath）。
   - 局部重绘：`image_gen`，传入 `prompt`、`reference_image` 与 `mask_image`。
4. 如需告知用户有哪些可选模型，调用 `list_image_models`。
5. 拿到返回的 `threadPath` 后，在回复中引用该路径，用户即可预览生成的图片。

### 提示词原则

- 用清晰的视觉描述，而非抽象评价。
- 需要保持参考图主体或构图时，在 prompt 中明确写出 `keep the same subject/composition`。
- 同一组图片保持风格、色调、光线描述一致。
- 用户未指定比例时按用途选择：头像/图标 `1:1`，横幅 `16:9`，海报 `3:4` 或 `4:5`。

### 输出格式

调用 `image_gen` 后，在回复里简要说明生成内容，并引用返回的 `threadPath` 让用户预览。如失败，如实说明并给出可调整方向。
```

注意：删除了原 frontmatter 的 `disable_model_invocation: true`；`allowed_tools` 改为 `image_gen`、`list_image_models`；删除了所有"当前 Lume 尚未接入""不要声称已经生成图片"等内容。

- [ ] **Step 2: 改造 agent-artist SKILL.md**

`apps/sidecar/default-skills/agent-artist/SKILL.md` 做 3 处精确替换（该 Skill 无 `disable_model_invocation`，frontmatter 仅需扩 `allowed_tools`）：

(a) frontmatter `allowed_tools` 加入两个图像工具：

- old: `allowed_tools: ["read_file", "edit_file", "write_file"]`
- new: `allowed_tools: ["read_file", "edit_file", "write_file", "image_gen", "list_image_models"]`

(b) 正文"尚未接入"声明整段替换：

- old: ``当前 Lume 尚未接入 `image_gen`、`list_image_models` 等图片生成工具，所以不要声称已经生成图片、已经调用模型、已经保存图片，或虚构图片链接和生成结果。你的职责是把视觉需求整理成高质量图像 brief、提示词和可交给真实生图工具执行的草稿。``
- new: ``Lume 已接入 `image_gen` 与 `list_image_models` 图片生成工具。把视觉需求整理成高质量 brief 与提示词后，调用 `image_gen` 生成真实图片，并在回复中引用返回的 `threadPath` 让用户预览。如需告知可用模型，调用 `list_image_models`。``

(c) "参考图 / 垫图 brief" 段开头一句替换：

- old: ``当用户提供参考图片或描述时，输出"参考图要求"而不是声称调用垫图：``
- new: ``当用户提供参考图、需保留主体改风格时，调用 `image_gen` 的 image-to-image 模式（`reference_image` 传参考图的 threadPath）。brief 草稿仍按下表整理：``

其余提示词工程、多方向输出、一致性原则等结构保留不变。

- [ ] **Step 3: 反转 inventory 测试断言**

打开 `apps/sidecar/src/services/skills/default-skills-inventory.test.ts`，找到 `"keeps image-gen as a guarded manual-only skill until image tools exist"` 这个 test（约 42 行），整体替换为：

```ts
  test("image-gen skill is backed by real image tools", () => {
    const { content, meta } = readDefaultSkill("image-gen");

    expect(meta.slug).toBe("image-gen");
    expect(meta.name).toBe("图片生成");
    expect(meta.description).toContain("生成");
    expect(meta.whenToUse).toContain("生成图片");
    expect(meta.disableModelInvocation).toBeFalsy();
    expect(meta.allowedTools ?? []).toContain("image_gen");
    expect(meta.allowedTools ?? []).toContain("list_image_models");
    expect(content).not.toContain("尚未接入");
    expect(content).not.toContain("不要声称已经生成图片");
  });
```

- [ ] **Step 4: 运行测试验证通过**

Run: `cd apps/sidecar && bun test src/services/skills/default-skills-inventory.test.ts`
Expected: PASS（含改造后的 image-gen 用例）

- [ ] **Step 5: 全量测试 + Commit**

Run: `cd apps/sidecar && bun test`
Expected: 全部 PASS（重点关注 image-gen 相关 6 个测试文件 + inventory）

```bash
git add apps/sidecar/default-skills/image-gen/SKILL.md apps/sidecar/default-skills/agent-artist/SKILL.md apps/sidecar/src/services/skills/default-skills-inventory.test.ts
git commit -m "✨ feat(sidecar): 图像生成 Skill 改造为调用真工具"
```

---

## 完成标准

- 所有 6 个 image-gen 测试文件 + inventory 测试 + wiring 测试全部 PASS。
- `cd apps/sidecar && bun run typecheck` 无错误。
- `image_gen` 与 `list_image_models` 出现在 `createLumeRuntimeTools` 的 `customTools` 与 `availableToolNames`。
- 在设置中配置 `models.imageGeneration.priorityModelRefs`（如 `doubao/seedream-3-0-t2i`）后，agent 调用 `image_gen` 能生成图片并在线程中预览（手动验证，可选）。

## 备注

- 真实 provider 联网不在自动化测试范围；如需手动端到端验证，配置好对应渠道后让 agent 调用 `image_gen`。
- 若将来要接入非 OpenAI 兼容协议（Google Imagen 原生、Midjourney），升级为 adapter 接口（差异已被 profile 隔离，重构成本低）。
