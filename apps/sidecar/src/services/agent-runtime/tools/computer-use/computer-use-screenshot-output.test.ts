import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveComputerUseScreenshots } from "./computer-use-screenshot-output";

let previousConfigDir: string | undefined;
let tempConfigDir = "";

beforeEach(() => {
  previousConfigDir = process.env.LUME_CONFIG_DIR;
  tempConfigDir = mkdtempSync(join(tmpdir(), "lume-computer-use-shot-"));
  process.env.LUME_CONFIG_DIR = tempConfigDir;
});

afterEach(() => {
  if (previousConfigDir === undefined) delete process.env.LUME_CONFIG_DIR;
  else process.env.LUME_CONFIG_DIR = previousConfigDir;
  rmSync(tempConfigDir, { recursive: true, force: true });
});

describe("saveComputerUseScreenshots", () => {
  test("writes screenshot pixels under the current thread files directory", () => {
    const png = Buffer.from("fake-png");
    const saved = saveComputerUseScreenshots({
      workspaceSlug: "demo",
      threadId: "thread-1",
      screenshots: [{
        id: "shot:1",
        mimeType: "image/png",
        width: 320,
        height: 200,
        dataUrl: `data:image/png;base64,${png.toString("base64")}`,
      }],
    });

    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      screenshotId: "shot:1",
      threadPath: expect.stringMatching(/^files\/computer-use\/.+\.png$/),
      mediaType: "image/png",
      width: 320,
      height: 200,
      size: png.length,
    });
    expect(existsSync(saved[0]!.absPath)).toBeTrue();
    expect(readFileSync(saved[0]!.absPath)).toEqual(png);
  });

  test("rejects unsupported screenshot media types", () => {
    expect(() => saveComputerUseScreenshots({
      workspaceSlug: "demo",
      threadId: "thread-1",
      screenshots: [{
        id: "shot:svg",
        mimeType: "image/svg+xml",
        dataUrl: "data:image/svg+xml;base64,PHN2Zy8+",
      }],
    })).toThrow("unsupported screenshot media type");
  });
});
