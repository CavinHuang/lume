"use client";

type PanelHeaderProps = {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
};

export function PanelHeader({ title, subtitle, actions }: PanelHeaderProps): React.ReactElement {
  return (
    <header className="flex items-start justify-between gap-3">
      <div>
        <h2 className="text-2xl font-semibold">{title}</h2>
        {subtitle ? <p className="text-sm text-muted-foreground">{subtitle}</p> : null}
      </div>
      {actions ? <div>{actions}</div> : null}
    </header>
  );
}
