import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
// @ts-ignore turndown-plugin-gfm currently has no published declarations.
import { gfm } from "turndown-plugin-gfm";

const turndown = createTurndown();

export function createTurndown(): TurndownService {
  const service = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  service.use(gfm);
  service.addRule("heading", {
    filter: ["h1", "h2", "h3", "h4", "h5", "h6"],
    replacement(content, node) {
      const level = Number(node.nodeName.charAt(1));
      return `\n\n${"#".repeat(level)} ${content.replace(/\\([.])/g, "$1").trim()}\n\n`;
    },
  });
  service.addRule("listItem", {
    filter: "li",
    replacement(content, node, options) {
      const body = content.replace(/^\n+/, "").replace(/\n+$/, "\n").replace(/\n/gm, "\n  ");
      const parent = node.parentNode as Element | null;
      const index = parent ? Array.prototype.indexOf.call(parent.children, node) : 0;
      const marker = parent?.nodeName === "OL"
        ? `${Number(parent.getAttribute("start") ?? 1) + index}.`
        : options.bulletListMarker;
      return `${marker} ${body}${node.nextSibling ? "\n" : ""}`;
    },
  });
  return service;
}

function normalizeCell(cell: HTMLElement): void {
  cell.innerHTML = cell.innerHTML
    .replace(/^\s*<p[^>]*>/i, "")
    .replace(/<\/p>\s*$/i, "")
    .replace(/<\/p>\s*<p[^>]*>/gi, " ");
}

/**
 * Normalize HTML tables before Turndown. GFM has no representation for merged
 * cells, so colspan/rowspan are expanded into a deterministic rectangular grid
 * and the merged value is kept in the first slot only.
 */
export function normalizeTablesHtml(html: string, url = "https://lume.invalid/"): string {
  const dom = new JSDOM(`<body>${html}</body>`, { url });
  const doc = dom.window.document;

  for (const table of Array.from(doc.querySelectorAll("table"))) {
    const rows = Array.from(table.querySelectorAll("tr"));
    if (rows.length === 0) continue;
    for (const cell of Array.from(table.querySelectorAll("td,th"))) normalizeCell(cell as HTMLElement);

    const grid: Array<Array<HTMLElement | undefined>> = [];
    const primary = new Set<string>();
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      const currentRow = grid[rowIndex] ??= [];
      let colIndex = 0;
      for (const cell of Array.from(rows[rowIndex]!.children).filter(
        (child): child is HTMLElement => child.tagName === "TD" || child.tagName === "TH",
      )) {
        while (currentRow[colIndex]) colIndex++;
        const rowSpan = Math.max(1, Number.parseInt(cell.getAttribute("rowspan") ?? "1", 10) || 1);
        const colSpan = Math.max(1, Number.parseInt(cell.getAttribute("colspan") ?? "1", 10) || 1);
        primary.add(`${rowIndex}:${colIndex}`);
        for (let r = 0; r < rowSpan; r++) {
          const targetRow = grid[rowIndex + r] ??= [];
          for (let c = 0; c < colSpan; c++) targetRow[colIndex + c] ??= cell;
        }
        colIndex += colSpan;
      }
    }

    const width = Math.max(...grid.map(row => row.length));
    const normalizedRows = grid.map((row, rowIndex) => {
      const tr = doc.createElement("tr");
      for (let colIndex = 0; colIndex < width; colIndex++) {
        const source = row[colIndex];
        if (!source) {
          tr.appendChild(doc.createElement("td"));
          continue;
        }
        const clone = source.cloneNode(true) as HTMLElement;
        clone.removeAttribute("rowspan");
        clone.removeAttribute("colspan");
        if (!primary.has(`${rowIndex}:${colIndex}`)) clone.textContent = "";
        tr.appendChild(clone);
      }
      return tr;
    });

    const hadHead = table.querySelector(":scope > thead") !== null;
    table.replaceChildren();
    const firstRow = normalizedRows[0];
    if (!hadHead && firstRow) {
      const head = doc.createElement("thead");
      for (const cell of Array.from(firstRow.children)) {
        const th = doc.createElement("th");
        th.innerHTML = cell.innerHTML;
        head.appendChild(th);
      }
      table.appendChild(head);
      if (normalizedRows.length > 1) {
        const body = doc.createElement("tbody");
        for (const row of normalizedRows.slice(1)) body.appendChild(row);
        table.appendChild(body);
      }
    } else {
      const body = doc.createElement("tbody");
      for (const row of normalizedRows) body.appendChild(row);
      table.appendChild(body);
    }
  }

  return doc.body.innerHTML;
}

function meaningfulText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function convertContent(html: string, url: string): string {
  return turndown.turndown(normalizeTablesHtml(html, url)).trim();
}

export function extractArticleMarkdown(
  html: string,
  url: string,
): { title: string; content: string } | null {
  const dom = new JSDOM(html, { url });
  const doc = dom.window.document;
  const article = new Readability(doc.cloneNode(true) as Document).parse();
  const articleText = meaningfulText(article?.textContent);

  const candidates = [
    doc.getElementById("js_content"),
    doc.querySelector("article"),
    doc.querySelector("main"),
    doc.querySelector("[role=main]"),
    doc.querySelector("#content"),
  ].filter((candidate): candidate is Element => candidate !== null);

  const bestCandidate = candidates
    .map(candidate => ({ candidate, text: meaningfulText(candidate.textContent) }))
    .sort((a, b) => b.text.length - a.text.length)[0];
  if (bestCandidate && bestCandidate.text.length > 200 && bestCandidate.text.length > articleText.length * 1.5) {
    return {
      title: article?.title || doc.title || "",
      content: convertContent(bestCandidate.candidate.innerHTML, url),
    };
  }

  if (!article || !articleText) return null;
  return {
    title: article.title || doc.title || "",
    content: convertContent(article.content ?? "", url),
  };
}
