/**
 * WebFetchTool - Fetch web content with Readability + Markdown conversion
 */

import { defineTool } from "./types.js";
import { ensureNetworkAllowed } from "../utils/pathing.js";
import { sdkFetch } from "./web-request.js";
import { extractArticleMarkdown } from "./html-to-markdown.js";

const MAX_FETCH_CHARS = 100000;

export const WebFetchTool = defineTool({
  name: "WebFetch",
  description:
    "Fetch content from a URL and return it as Markdown. Strips boilerplate using Mozilla Readability for clean article extraction.",
  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "The URL to fetch content from",
      },
      format: {
        type: "string",
        enum: ["markdown", "text", "html"],
        description: "Output format. Default: markdown",
      },
    },
    required: ["url"],
  },
  isReadOnly: true,
  isConcurrencySafe: true,
  async call(input, context) {
    const { url } = input;
    const format = input.format === "text" || input.format === "html" ? input.format : "markdown";

    const sandboxError = ensureNetworkAllowed(url, context.sandbox);
    if (sandboxError) {
      return { data: sandboxError, is_error: true };
    }

    try {
      const response = await sdkFetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        },
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        return { data: `HTTP ${response.status}: ${response.statusText}`, is_error: true };
      }

      const contentType = response.headers.get("content-type") || "";
      let text = await response.text();

      if (text.length > MAX_FETCH_CHARS) {
        text = text.slice(0, MAX_FETCH_CHARS);
      }

      if (contentType.includes("text/html") || text.trimStart().startsWith("<")) {
        if (format === "html") {
          return { data: text };
        }

        const article = extractArticleMarkdown(text, url);
        if (article) {
          if (format === "text") {
            return { data: `# ${article.title}\n\n${article.content.replace(/[#*_`>\[\]()!-]/g, "")}` };
          }
          return { data: `# ${article.title}\n\n${article.content}` };
        }

        // Readability failed — strip tags as fallback
        const stripped = text
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        return { data: stripped || "(empty response)" };
      }

      return { data: text || "(empty response)" };
    } catch (err: any) {
      return { data: `Error fetching ${url}: ${err.message}`, is_error: true };
    }
  },
});
