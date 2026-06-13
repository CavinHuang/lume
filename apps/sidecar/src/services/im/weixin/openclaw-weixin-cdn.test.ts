import { describe, expect, test } from "bun:test";
import { aesEcbEncrypt, aesEcbPaddedSize, uploadMediaToWeixinCdn } from "./openclaw-weixin-cdn";

describe("openclaw-weixin-cdn", () => {
  describe("aesEcbPaddedSize", () => {
    test("rounds up to next 16-byte boundary", () => {
      expect(aesEcbPaddedSize(0)).toBe(16);
      expect(aesEcbPaddedSize(1)).toBe(16);
      expect(aesEcbPaddedSize(15)).toBe(16);
      expect(aesEcbPaddedSize(16)).toBe(32);
      expect(aesEcbPaddedSize(100)).toBe(112);
    });
  });

  describe("aesEcbEncrypt", () => {
    test("produces 16-byte-aligned ciphertext", () => {
      const key = Buffer.alloc(16, 0x42);
      const plaintext = Buffer.from("hello world");
      const encrypted = aesEcbEncrypt(plaintext, key);
      expect(encrypted.length).toBe(16);
      expect(encrypted.length % 16).toBe(0);
    });

    test("is deterministic for same key and plaintext", () => {
      const key = Buffer.alloc(16, 0x42);
      const plaintext = Buffer.from("test data for encryption");
      const enc1 = aesEcbEncrypt(plaintext, key);
      const enc2 = aesEcbEncrypt(plaintext, key);
      expect(enc1.equals(enc2)).toBe(true);
    });

    test("produces different output for different keys", () => {
      const key1 = Buffer.alloc(16, 0x11);
      const key2 = Buffer.alloc(16, 0x22);
      const plaintext = Buffer.from("same plaintext");
      const enc1 = aesEcbEncrypt(plaintext, key1);
      const enc2 = aesEcbEncrypt(plaintext, key2);
      expect(enc1.equals(enc2)).toBe(false);
    });
  });

  describe("uploadMediaToWeixinCdn", () => {
    const account = {
      baseUrl: "https://ilink.example.com",
      token: "test-token",
    };

    test("calls getuploadurl and uploads encrypted data to CDN", async () => {
      const calls: Array<{ url: string; body?: string }> = [];
      const downloadParam = "cdn-download-param-abc";

      const fetchImpl = async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), body: typeof init?.body === "string" ? init.body : undefined });
        if (String(url).includes("getuploadurl")) {
          return Response.json({
            upload_full_url: "https://cdn.example.com/upload",
            upload_param: "enc-param",
          });
        }
        return Response.json({ downloadParam });
      };

      const result = await uploadMediaToWeixinCdn({
        fileData: Buffer.from("test image data"),
        mediaType: 1,
        toUserId: "user-1",
        account,
        fetchImpl,
      });

      expect(calls.length).toBe(2);
      expect(calls[0]?.url).toContain("getuploadurl");
      expect(calls[1]?.url).toBe("https://cdn.example.com/upload");
      expect(result.downloadEncryptedQueryParam).toBe(downloadParam);
      expect(result.fileSize).toBe(15);
      expect(result.aeskey).toBeTruthy();
      expect(result.filekey).toBeTruthy();
    });

    test("throws when getuploadurl returns no upload URL", async () => {
      const fetchImpl = async () => Response.json({});
      await expect(
        uploadMediaToWeixinCdn({
          fileData: Buffer.from("data"),
          mediaType: 1,
          toUserId: "user-1",
          account,
          fetchImpl,
        })
      ).rejects.toThrow("getuploadurl returned no upload URL");
    });
  });
});
