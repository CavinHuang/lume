import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { SafeHttpFetchService } from "../infra/safe-http-fetch";
import { resolveMediaContents } from "./im-media-resolver";
import { aesEcbEncrypt } from "./weixin/openclaw-weixin-cdn";
import type { ImMessageContent } from "@lume/shared";

const CDN_BASE = "https://cdn.example.com";

/**
 * #598：生产走 SafeHttpFetchService（DNS 公网校验 + maxBytes）。测试经构造器
 * DI 固定 DNS 解析与 HTTP 响应，不触网。
 */
function makeSafeFetcher(
  respond: (url: string) => { status: number; headers?: Record<string, string | string[]>; body: Uint8Array },
): SafeHttpFetchService {
  return new SafeHttpFetchService({
    resolve: async () => [{ address: "203.0.113.10", family: 4 }],
    request: async (url) => {
      const r = respond(url.toString());
      return { status: r.status, headers: r.headers ?? {}, body: r.body };
    },
  });
}

describe("im-media-resolver", () => {
  test("returns non-media contents unchanged", async () => {
    const contents: ImMessageContent[] = [
      { type: "text", text: "hello" },
      { type: "voice", text: "hi", playtime: 2000 },
      { type: "file", fileName: "a.pdf", fileSize: 100 },
    ];

    const resolved = await resolveMediaContents(contents);
    expect(resolved).toEqual(contents);
  });

  test("replaces image with text placeholder when download fails", async () => {
    const contents: ImMessageContent[] = [
      { type: "image", url: `${CDN_BASE}/broken.jpg` },
    ];

    const resolved = await resolveMediaContents(contents, {
      cdnBaseUrl: CDN_BASE,
      safeFetch: makeSafeFetcher(() => ({ status: 404, body: new Uint8Array() })),
    });
    expect(resolved).toEqual([{ type: "text", text: "[图片: 下载失败]" }]);
  });

  test("keeps remote image url when download succeeds without saveMedia", async () => {
    const contents: ImMessageContent[] = [
      { type: "image", url: `${CDN_BASE}/img.jpg` },
    ];

    const resolved = await resolveMediaContents(contents, {
      cdnBaseUrl: CDN_BASE,
      safeFetch: makeSafeFetcher(() => ({ status: 200, headers: { "content-type": "image/png" }, body: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) })),
    });
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.type).toBe("image");
    expect((resolved[0] as { url: string }).url).toBe(`${CDN_BASE}/img.jpg`);
  });

  test("handles network error gracefully", async () => {
    const contents: ImMessageContent[] = [
      { type: "image", url: `${CDN_BASE}/error.jpg` },
    ];

    const resolved = await resolveMediaContents(contents, {
      cdnBaseUrl: CDN_BASE,
      safeFetch: makeSafeFetcher(() => {
        throw new Error("Network error");
      }),
    });
    expect(resolved).toEqual([{ type: "text", text: "[图片: 下载失败]" }]);
  });

  test("downloads image and points url to saved threadPath", async () => {
    const contents: ImMessageContent[] = [
      { type: "image", url: `${CDN_BASE}/img.png` },
    ];

    const saved: Array<{ filename: string; mediaType: string; size: number }> = [];
    const saveMedia = async (input: { filename: string; data: Buffer; mediaType: string }) => {
      saved.push({ filename: input.filename, mediaType: input.mediaType, size: input.data.length });
      return `attachments/${input.filename}`;
    };

    const resolved = await resolveMediaContents(contents, {
      cdnBaseUrl: CDN_BASE,
      saveMedia,
      safeFetch: makeSafeFetcher(() => ({ status: 200, headers: { "content-type": "image/png" }, body: new Uint8Array([1, 2, 3]) })),
    });
    expect(resolved[0]).toMatchObject({ type: "image", url: "attachments/im-image-0.png" });
    expect(saved[0]).toMatchObject({ filename: "im-image-0.png", mediaType: "image/png", size: 3 });
  });

  test("downloads file and points downloadUrl to saved threadPath", async () => {
    const contents: ImMessageContent[] = [
      { type: "file", fileName: "report.pdf", fileSize: 5, downloadUrl: `${CDN_BASE}/report.pdf` },
    ];

    const saveMedia = async (input: { filename: string; data: Buffer; mediaType: string }) =>
      `attachments/${input.filename}`;

    const resolved = await resolveMediaContents(contents, {
      cdnBaseUrl: CDN_BASE,
      saveMedia,
      safeFetch: makeSafeFetcher(() => ({ status: 200, headers: {}, body: new Uint8Array([1, 2, 3, 4, 5]) })),
    });
    expect(resolved[0]).toMatchObject({
      type: "file",
      fileName: "report.pdf",
      downloadUrl: "attachments/report.pdf",
    });
  });

  test("builds CDN download URL from encrypt_query_param when url is not http", async () => {
    const contents: ImMessageContent[] = [
      { type: "file", fileName: "report.pdf", fileSize: 5, downloadUrl: "enc-param-xyz" },
    ];

    const calls: string[] = [];
    const saveMedia = async (input: { filename: string; data: Buffer; mediaType: string }) =>
      `attachments/${input.filename}`;

    await resolveMediaContents(contents, {
      cdnBaseUrl: CDN_BASE,
      saveMedia,
      safeFetch: makeSafeFetcher((url) => {
        calls.push(url);
        return { status: 200, headers: {}, body: new Uint8Array([1, 2, 3, 4, 5]) };
      }),
    });
    expect(calls[0]).toBe("https://cdn.example.com/download?encrypted_query_param=enc-param-xyz");
  });

  test("#598 rejects media URL whose host differs from the account CDN", () => {
    return (async () => {
      const contents: ImMessageContent[] = [
        { type: "image", url: "https://evil.example.com/steal.jpg" },
      ];

      let fetched = false;
      const resolved = await resolveMediaContents(contents, {
        cdnBaseUrl: CDN_BASE,
        safeFetch: makeSafeFetcher(() => {
          fetched = true;
          return { status: 200, headers: {}, body: new Uint8Array([1]) };
        }),
      });
      expect(resolved).toEqual([{ type: "text", text: "[图片: 下载失败]" }]);
      expect(fetched).toBe(false);
    })();
  });

  test("#598 fails closed when message supplies absolute URL but account has no cdnBaseUrl", async () => {
    const contents: ImMessageContent[] = [
      { type: "image", url: "https://cdn.example.com/img.jpg" },
    ];

    let fetched = false;
    const resolved = await resolveMediaContents(contents, {
      safeFetch: makeSafeFetcher(() => {
        fetched = true;
        return { status: 200, headers: {}, body: new Uint8Array([1]) };
      }),
    });
    expect(resolved).toEqual([{ type: "text", text: "[图片: 下载失败]" }]);
    expect(fetched).toBe(false);
  });

  test("#598 same-host URL with spoofed path casing still allowed by host match", async () => {
    const contents: ImMessageContent[] = [
      { type: "image", url: `${CDN_BASE}/IMG.PNG` },
    ];
    const resolved = await resolveMediaContents(contents, {
      cdnBaseUrl: CDN_BASE,
      safeFetch: makeSafeFetcher(() => ({ status: 200, headers: { "content-type": "image/png" }, body: new Uint8Array([1, 2, 3]) })),
    });
    expect(resolved[0]!.type).toBe("image");
  });

  test("image-class file extension yields image mediaType", async () => {
    const contents: ImMessageContent[] = [
      { type: "file", fileName: "photo.png", fileSize: 3, downloadUrl: `${CDN_BASE}/photo.png` },
    ];

    let savedType = "";
    const saveMedia = async (input: { filename: string; data: Buffer; mediaType: string }) => {
      savedType = input.mediaType;
      return `attachments/${input.filename}`;
    };

    await resolveMediaContents(contents, {
      cdnBaseUrl: CDN_BASE,
      saveMedia,
      safeFetch: makeSafeFetcher(() => ({ status: 200, headers: { "content-type": "image/png" }, body: new Uint8Array([1, 2, 3]) })),
    });
    expect(savedType).toBe("image/png");
  });

  test("file download failure yields text placeholder", async () => {
    const contents: ImMessageContent[] = [
      { type: "file", fileName: "report.pdf", fileSize: 5, downloadUrl: `${CDN_BASE}/report.pdf` },
    ];

    const saveMedia = async () => "x";

    const resolved = await resolveMediaContents(contents, {
      cdnBaseUrl: CDN_BASE,
      saveMedia,
      safeFetch: makeSafeFetcher(() => ({ status: 500, body: new Uint8Array() })),
    });
    expect(resolved).toEqual([{ type: "text", text: "[文件: report.pdf（下载失败）]" }]);
  });

  test("decrypts CDN ciphertext before saving when file has aesKey", async () => {
    const key = randomBytes(16);
    const plaintext = Buffer.from("# code.py\nprint('hello 微信文件')\n", "utf-8");
    const ciphertext = aesEcbEncrypt(plaintext, key);
    const aesKeyField = Buffer.from(key.toString("hex")).toString("base64"); // file/voice/video encoding
    const contents: ImMessageContent[] = [
      { type: "file", fileName: "code.py", fileSize: plaintext.length, downloadUrl: "enc-param-1", aesKey: aesKeyField },
    ];

    let savedData: Buffer | undefined;
    const saveMedia = async (input: { filename: string; data: Buffer; mediaType: string }) => {
      savedData = input.data;
      return `attachments/${input.filename}`;
    };

    const resolved = await resolveMediaContents(contents, {
      cdnBaseUrl: CDN_BASE,
      saveMedia,
      safeFetch: makeSafeFetcher(() => ({ status: 200, headers: {}, body: new Uint8Array(ciphertext) })),
    });
    expect(resolved[0]).toMatchObject({ type: "file", downloadUrl: "attachments/code.py" });
    expect(savedData?.equals(plaintext)).toBe(true); // 明文落盘，非密文
  });

  test("decrypts CDN ciphertext before saving when image has aesKey", async () => {
    const key = randomBytes(16);
    const plaintext = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const ciphertext = aesEcbEncrypt(plaintext, key);
    const aesKeyField = key.toString("base64"); // image encoding: base64(raw 16 bytes)
    const contents: ImMessageContent[] = [
      { type: "image", url: "enc-param-img", aesKey: aesKeyField },
    ];

    let savedData: Buffer | undefined;
    const saveMedia = async (input: { filename: string; data: Buffer; mediaType: string }) => {
      savedData = input.data;
      return `attachments/${input.filename}`;
    };

    const resolved = await resolveMediaContents(contents, {
      cdnBaseUrl: CDN_BASE,
      saveMedia,
      safeFetch: makeSafeFetcher(() => ({ status: 200, headers: { "content-type": "image/png" }, body: new Uint8Array(ciphertext) })),
    });
    expect(resolved[0]).toMatchObject({ type: "image", url: "attachments/im-image-0.png" });
    expect(savedData?.equals(plaintext)).toBe(true);
  });
});
