"use client";

import { FormEvent, useState } from "react";

interface ChatInputProps {
  disabled?: boolean;
  onSend: (text: string) => Promise<void>;
  onStop: () => void;
  onClearContext?: () => void;
}

export function ChatInput({ disabled, onSend, onStop, onClearContext }: ChatInputProps): React.ReactElement {
  const [draft, setDraft] = useState("");

  const canSend = !disabled && draft.trim().length > 0;

  const handleSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!canSend) return;
    const content = draft.trim();
    setDraft("");
    await onSend(content);
  };

  return (
    <form className="grid grid-cols-1 gap-2 md:grid-cols-[1fr_auto_auto_auto]" onSubmit={handleSubmit}>
      <input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="输入消息..."
        className="h-10 rounded-md border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100 outline-none focus:border-cyan-400"
      />
      <button type="button" className="rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm hover:bg-slate-700" onClick={onClearContext}>Context</button>
      <button type="submit" className="rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm hover:bg-slate-700 disabled:opacity-50" disabled={!canSend}>Send</button>
      <button type="button" className="rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm hover:bg-slate-700" onClick={onStop}>Stop</button>
    </form>
  );
}
