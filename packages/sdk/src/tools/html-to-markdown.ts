import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
});

export function extractArticleMarkdown(
  html: string,
  url: string
): { title: string; content: string } | null {
  const dom = new JSDOM(html, { url });
  const doc = dom.window.document;
  if (!doc) return null;

  const reader = new Readability(doc);
  const article = reader.parse();
  if (!article || !article.textContent?.trim()) return null;

  const markdown = turndown.turndown(article.content ?? "");
  return {
    title: article.title || "",
    content: markdown,
  };
}
