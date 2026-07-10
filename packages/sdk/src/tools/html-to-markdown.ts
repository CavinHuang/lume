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
  const articleText = (article?.textContent || "").replace(/\s+/g, " ").trim();

  // 回退：Readability 对部分站点结构（如微信公众号 rich_media_content / js_content）会漏抽正文。
  // 若已知正文容器的文字量远超 Readability 结果，改用该容器（Turndown 其 innerHTML）。
  const candidate =
    doc.getElementById("js_content") ||
    doc.querySelector("article") ||
    doc.querySelector("main");
  if (candidate) {
    const candText = (candidate.textContent || "").replace(/\s+/g, " ").trim();
    if (candText.length > 200 && candText.length > articleText.length * 2 + 200) {
      return {
        title: article?.title || doc.title || "",
        content: turndown.turndown(candidate.innerHTML),
      };
    }
  }

  if (!article || !articleText) return null;
  return {
    title: article.title || "",
    content: turndown.turndown(article.content ?? ""),
  };
}
