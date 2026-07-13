import { describe, expect, test } from "bun:test";
import { cropPng } from "./png-region";

const FOUR_BANDS_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAIAAAAAgCAIAAABVQOdyAAAAV0lEQVR42u3RsQ0AAAzCMP5/mh5RsVnKnMVpMm2873w/LgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMC/AyLv7R6HOOOKAAAAAElFTkSuQmCC",
  "base64",
);

describe("cropPng", () => {
  test("crops an 8-bit RGB PNG without external image dependencies", () => {
    const cropped = cropPng(FOUR_BANDS_PNG, { x: 32, y: 0, width: 32, height: 32 });
    expect(cropped.width).toBe(32);
    expect(cropped.height).toBe(32);
    expect(cropped.bytes.subarray(0, 8)).toEqual(Buffer.from("89504e470d0a1a0a", "hex"));
    expect(cropped.bytes.readUInt32BE(16)).toBe(32);
    expect(cropped.bytes.readUInt32BE(20)).toBe(32);
  });

  test("rejects regions outside the captured image", () => {
    expect(() => cropPng(FOUR_BANDS_PNG, { x: 127, y: 0, width: 2, height: 1 }))
      .toThrow("outside screenshot bounds");
  });
});
