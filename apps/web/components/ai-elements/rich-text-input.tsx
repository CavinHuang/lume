"use client";

import { useState } from "react";

type RichTextInputProps = {
  placeholder?: string;
  disabled?: boolean;
  onSubmit: (value: string) => void | Promise<void>;
};

export function RichTextInput({
  placeholder = "输入内容...",
  disabled,
  onSubmit
}: RichTextInputProps): React.ReactElement {
  const [value, setValue] = useState("");
  return (
    <form
      className="grid grid-cols-1 gap-2 md:grid-cols-[1fr_auto]"
      onSubmit={(event) => {
        event.preventDefault();
        const text = value.trim();
        if (!text || disabled) return;
        setValue("");
        void onSubmit(text);
      }}
    >
      <textarea
        className="min-h-[76px] resize-y rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan-400"
        rows={3}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder={placeholder}
        disabled={disabled}
      />
      <button type="submit" className="rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm hover:bg-slate-700 disabled:opacity-50" disabled={disabled || value.trim().length === 0}>
        Send
      </button>
    </form>
  );
}
