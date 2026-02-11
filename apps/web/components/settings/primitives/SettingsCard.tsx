"use client";

import type { ReactNode } from "react";
import { CARD_CLASS } from "./SettingsUIConstants";

type SettingsCardProps = {
  children: ReactNode;
  className?: string;
  divided?: boolean;
};

export function SettingsCard({
  children,
  className,
  divided = true
}: SettingsCardProps): React.ReactElement {
  const items = Array.isArray(children) ? children.filter(Boolean) : [children];
  return (
    <div className={[CARD_CLASS, className].filter(Boolean).join(" ")}>
      {divided
        ? items.map((child, index) => (
            <div key={index} className={index === 0 ? "p-2.5" : "border-t border-slate-700 p-2.5"}>
              {child}
            </div>
          ))
        : children}
    </div>
  );
}
