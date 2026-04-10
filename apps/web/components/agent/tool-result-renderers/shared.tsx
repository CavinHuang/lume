import * as React from "react";

export function ErrorResult({ result }: { result: string }): React.ReactElement {
  return (
    <pre className="overflow-x-auto rounded-md bg-destructive/5 p-3 font-mono text-[12px] text-destructive/80 whitespace-pre-wrap break-all">
      {result}
    </pre>
  );
}

