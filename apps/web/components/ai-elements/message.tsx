"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock, MermaidBlock } from "@lume/ui";

type AIMessageProps = {
  content: string;
};

export function AIMessage({ content }: AIMessageProps): React.ReactElement {
  return (
    <div className="prose prose-sm max-w-none break-words prose-p:my-0 prose-pre:my-0 prose-code:font-mono prose-headings:text-slate-100 prose-strong:text-slate-100 prose-li:my-0.5">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code(props) {
            const { className, children, ...rest } = props;
            const code = String(children ?? "");
            const lang = className?.replace("language-", "").trim().toLowerCase();
            if (lang === "mermaid") {
              return <MermaidBlock code={code.replace(/\n$/, "")} />;
            }
            return (
              <CodeBlock>
                <code className={className} {...rest}>
                  {children}
                </code>
              </CodeBlock>
            );
          }
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
