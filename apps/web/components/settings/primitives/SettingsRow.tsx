"use client";

import type { ReactNode } from "react";
import { DESCRIPTION_CLASS, LABEL_CLASS, ROW_CLASS } from "./SettingsUIConstants";

type SettingsRowProps = {
  label: string;
  icon?: ReactNode;
  description?: string;
  children?: ReactNode;
  className?: string;
};

export function SettingsRow({
  label,
  icon,
  description,
  children,
  className
}: SettingsRowProps): React.ReactElement {
  return (
    <div className={[ROW_CLASS, className].filter(Boolean).join(" ")}>
      {icon ? <div>{icon}</div> : null}
      <div className="mr-2 min-w-0 flex-1">
        <div className={LABEL_CLASS}>{label}</div>
        {description ? <div className={DESCRIPTION_CLASS}>{description}</div> : null}
      </div>
      {children ? <div>{children}</div> : null}
    </div>
  );
}
