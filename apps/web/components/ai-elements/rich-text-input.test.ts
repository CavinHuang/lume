import { describe, expect, test } from "bun:test";
import { shouldSubmitOnEnter } from "./rich-text-input";

describe("shouldSubmitOnEnter", () => {
  test("普通 Enter 应触发提交", () => {
    expect(shouldSubmitOnEnter({
      key: "Enter",
      shiftKey: false,
      isComposing: false,
      nativeIsComposing: false,
      nativeKeyCode: 13
    })).toBe(true);
  });

  test("Shift+Enter 不应触发提交", () => {
    expect(shouldSubmitOnEnter({
      key: "Enter",
      shiftKey: true,
      isComposing: false,
      nativeIsComposing: false,
      nativeKeyCode: 13
    })).toBe(false);
  });

  test("输入法组合态 Enter 选词不应触发提交", () => {
    expect(shouldSubmitOnEnter({
      key: "Enter",
      shiftKey: false,
      isComposing: true,
      nativeIsComposing: true,
      nativeKeyCode: 229
    })).toBe(false);
  });

  test("输入法兜底事件 keyCode 229 不应触发提交", () => {
    expect(shouldSubmitOnEnter({
      key: "Enter",
      shiftKey: false,
      isComposing: false,
      nativeIsComposing: false,
      nativeKeyCode: 229
    })).toBe(false);
  });
});
