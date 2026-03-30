import { cn } from "@/lib/utils";

type PanelProps = {
  variant?: "shrink" | "grow";
  width?: number;
  className?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
};

export function Panel({
  variant = "grow",
  width,
  className,
  style,
  children
}: PanelProps): React.ReactElement {
  return (
    <section
      className={cn(
        "flex h-full min-w-0 flex-col overflow-hidden",
        variant === "grow" && "flex-1",
        variant === "shrink" && "shrink-0",
        className
      )}
      style={{
        ...(variant === "shrink" && width ? { width } : {}),
        ...style
      }}
    >
      {children}
    </section>
  );
}
