import { describe, expect, test } from "bun:test";
import { strToU8, zipSync } from "fflate";
import { renderStructuredBinary, zipEntries } from "./web-fetch-content.js";

/** Overwrite the local + central directory uncompressed-size fields with a lie. */
function lieAboutSizes(zip: Uint8Array, claimedSize: number): void {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  view.setUint32(22, claimedSize, true); // local file header: uncompressed size
  for (let i = 0; i < zip.length - 4; i++) {
    if (zip[i] === 0x50 && zip[i + 1] === 0x4b && zip[i + 2] === 0x01 && zip[i + 3] === 0x02) {
      view.setUint32(i + 24, claimedSize, true); // central directory entry: uncompressed size
      return;
    }
  }
}

describe("renderStructuredBinary", () => {
  test("lists archive files and readable text entries", async () => {
    const archive = zipSync({ "README.md": strToU8("# Hello archive"), "image.bin": Uint8Array.from([1, 2, 3]) });
    const result = await renderStructuredBinary(archive, "application/zip", "https://example.com/a.zip");
    expect(result?.markdown).toContain("README.md");
    expect(result?.markdown).toContain("Hello archive");
  });

  test("aborts archives whose uncompressed entries exceed the budget (#219)", async () => {
    const big = new Uint8Array(40 * 1024 * 1024);
    const archive = zipSync({ "a.bin": big, "b.bin": big });
    expect(renderStructuredBinary(archive, "application/zip", "https://example.com/a.zip"))
      .rejects.toThrow("uncompressed size exceeds");
  });

  test("converts a minimal DOCX fixture through Mammoth", async () => {
    const docx = zipSync({
      "[Content_Types].xml": strToU8("<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/></Types>"),
      "word/document.xml": strToU8("<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body><w:p><w:r><w:t>Hello DOCX</w:t></w:r></w:p></w:body></w:document>"),
    });
    const result = await renderStructuredBinary(docx, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "https://example.com/a.docx");
    expect(result?.markdown).toContain("Hello DOCX");
  });
});

describe("zipEntries real-byte metering (#340)", () => {
  test("measures actual inflated bytes instead of trusting central-directory sizes", () => {
    const payload = new Uint8Array(256 * 1024); // zeros deflate to a few hundred bytes
    const archive = zipSync({ "big.bin": payload });
    lieAboutSizes(archive, 100);
    const entries = zipEntries(archive);
    expect(entries["big.bin"].byteLength).toBe(256 * 1024);
  });

  test("still extracts stored (method 0) entries", () => {
    const archive = zipSync({ "note.txt": strToU8("plain stored text") }, { level: 0 });
    const entries = zipEntries(archive);
    expect(new TextDecoder().decode(entries["note.txt"])).toBe("plain stored text");
  });
});
