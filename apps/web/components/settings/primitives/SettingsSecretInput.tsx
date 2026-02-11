"use client";

import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Input } from "@/components/ui/input";
import { DESCRIPTION_CLASS, LABEL_CLASS } from "./SettingsUIConstants";

type SettingsSecretInputProps = {
  label: string;
  description?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
};

export function SettingsSecretInput({
  label,
  description,
  value,
  onChange,
  placeholder,
  required,
  disabled
}: SettingsSecretInputProps): React.ReactElement {
  const [visible, setVisible] = useState(false);
  return (
    <div className="flex flex-col gap-1.5 px-1 py-1">
      <div className={LABEL_CLASS}>{label}</div>
      {description ? <div className={DESCRIPTION_CLASS}>{description}</div> : null}
      <div className="relative">
        <Input
          className="border-slate-700 bg-slate-950 pr-9"
          type={visible ? "text" : "password"}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          required={required}
          disabled={disabled}
        />
        <button type="button" className="absolute right-2 top-1/2 -translate-y-1/2 rounded border border-slate-700 bg-slate-950 px-1.5 py-1 text-slate-300" onClick={() => setVisible((prev) => !prev)}>
          {visible ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
      </div>
    </div>
  );
}
