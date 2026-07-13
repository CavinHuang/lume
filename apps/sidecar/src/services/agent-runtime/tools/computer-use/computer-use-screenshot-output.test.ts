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
      screenshotId: expect.stringMatching(/^screenshot:/),
      threadPath: expect.stringMatching(/^files\/computer-use\/.+\.png$/),
      mediaType: "image/png",
      width: 320,
      height: 200,
      size: png.length,
    });
    expect(existsSync(saved[0]!.absPath)).toBeTrue();
    expect(readFileSync(saved[0]!.absPath)).toEqual(png);

    const second = saveComputerUseScreenshots({
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
    expect(second[0]!.screenshotId).not.toBe(saved[0]!.screenshotId);
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

  test("preserves the host v2 screenshot id used for action cache validation", () => {
    const saved = saveComputerUseScreenshots({
      workspaceSlug: "demo",
      threadId: "thread-1",
      screenshots: [{
        id: "screenshot:42:100:1",
        mimeType: "image/png",
        dataUrl: `data:image/png;base64,${Buffer.from("png").toString("base64")}`,
      }],
    });
    expect(saved[0]!.screenshotId).toBe("screenshot:42:100:1");
  });

  test("writes only the requested screenshot region", () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAIAAAAAgCAIAAABVQOdyAAAAV0lEQVR42u3RsQ0AAAzCMP5/mh5RsVnKnMVpMm2873w/LgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMC/AyLv7R6HOOOKAAAAAElFTkSuQmCC",
      "base64",
    );
    const saved = saveComputerUseScreenshots({
      workspaceSlug: "demo",
      threadId: "thread-1",
      pixelRegion: { x: 32, y: 0, width: 32, height: 32 },
      screenshots: [{
        id: "screenshot:42:region:1",
        mimeType: "image/png",
        width: 128,
        height: 32,
        dataUrl: `data:image/png;base64,${png.toString("base64")}`,
      }],
    });
    const written = readFileSync(saved[0]!.absPath);
    expect(saved[0]).toMatchObject({ width: 32, height: 32 });
    expect(written.readUInt32BE(16)).toBe(32);
    expect(written.readUInt32BE(20)).toBe(32);
  });
});
