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

    test("uploads encrypted bytes as application/octet-stream and reads x-encrypted-param header", async () => {
      const calls: Array<{ url: string; contentType?: string; bodyKind?: string; bodyLength?: number }> = [];
      const downloadParam = "cdn-download-param-abc";

      const fetchImpl = async (url: string, init?: RequestInit) => {
        const headers = init?.headers as Record<string, string> | undefined;
        const body = init?.body;
        calls.push({
          url: String(url),
          contentType: headers?.["Content-Type"] ?? headers?.["content-type"],
          bodyKind: body instanceof Uint8Array ? "uint8array" : undefined,
          bodyLength: body instanceof Uint8Array ? body.byteLength : undefined,
        });
        if (String(url).includes("getuploadurl")) {
          return Response.json({
            upload_full_url: "https://cdn.example.com/upload",
            upload_param: "enc-param",
          });
        }
        // CDN returns the download param via response header, not JSON body
        return new Response(null, {
          status: 200,
          headers: { "x-encrypted-param": downloadParam },
        });
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
      // CDN POST must be raw octet-stream bytes, not multipart/form-data
      expect(calls[1]?.url).toBe("https://cdn.example.com/upload");
      expect(calls[1]?.contentType).toBe("application/octet-stream");
      expect(calls[1]?.bodyKind).toBe("uint8array");
      expect(calls[1]?.bodyLength).toBe(16); // AES-128-ECB padded size of 15 bytes
      expect(result.downloadEncryptedQueryParam).toBe(downloadParam);
      expect(result.fileSize).toBe(15);
      expect(result.aeskey).toBeTruthy();
      expect(result.filekey).toBeTruthy();
    });

    test("throws on CDN server error (non-200)", async () => {
      const fetchImpl = async (url: string) => {
        if (String(url).includes("getuploadurl")) {
          return Response.json({ upload_full_url: "https://cdn.example.com/upload" });
        }
        return new Response(null, {
          status: 500,
          headers: { "x-error-message": "decrypt failed" },
        });
      };

      await expect(
        uploadMediaToWeixinCdn({
          fileData: Buffer.from("test image data"),
          mediaType: 1,
          toUserId: "user-1",
          account,
          fetchImpl,
        })
      ).rejects.toThrow(/CDN upload failed \(500\): decrypt failed/);
    });

    test("throws when CDN response missing x-encrypted-param header", async () => {
      const fetchImpl = async (url: string) => {
        if (String(url).includes("getuploadurl")) {
          return Response.json({ upload_full_url: "https://cdn.example.com/upload" });
        }
        return new Response(null, { status: 200 });
      };

      await expect(
        uploadMediaToWeixinCdn({
          fileData: Buffer.from("test image data"),
          mediaType: 1,
          toUserId: "user-1",
          account,
          fetchImpl,
        })
      ).rejects.toThrow(/missing x-encrypted-param header/);
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
