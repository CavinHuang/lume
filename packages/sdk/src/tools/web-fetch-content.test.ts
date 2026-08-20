import { describe, expect, test } from "bun:test";
import { strToU8, zipSync } from "fflate";
import { renderStructuredBinary } from "./web-fetch-content.js";

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
