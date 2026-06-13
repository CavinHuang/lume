import { describe, expect, test } from "bun:test";
import { resolveMediaContents } from "./im-media-resolver";
import type { ImMessageContent } from "@lume/shared";

describe("im-media-resolver", () => {
  test("returns non-image contents unchanged", async () => {
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
      { type: "image", url: "https://cdn.example.com/broken.jpg" },
    ];

    const fetchImpl = async () => {
      return new Response("not found", { status: 404 });
    };

    const resolved = await resolveMediaContents(contents, { fetchImpl });
    expect(resolved).toEqual([{ type: "text", text: "[图片: 下载失败]" }]);
  });

  test("keeps image content when download succeeds", async () => {
    const contents: ImMessageContent[] = [
      { type: "image", url: "https://cdn.example.com/img.jpg" },
    ];

    const fetchImpl = async () => {
      return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    };

    const resolved = await resolveMediaContents(contents, { fetchImpl });
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.type).toBe("image");
  });

  test("handles network error gracefully", async () => {
    const contents: ImMessageContent[] = [
      { type: "image", url: "https://cdn.example.com/error.jpg" },
    ];

    const fetchImpl = async () => {
      throw new Error("Network error");
    };

    const resolved = await resolveMediaContents(contents, { fetchImpl });
    expect(resolved).toEqual([{ type: "text", text: "[图片: 下载失败]" }]);
  });
});
