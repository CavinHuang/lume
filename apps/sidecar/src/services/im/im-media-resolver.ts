import type { ImMessageContent } from "@lume/shared";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export async function resolveMediaContents(
  contents: ImMessageContent[],
  options?: { fetchImpl?: FetchLike }
): Promise<ImMessageContent[]> {
  return Promise.all(
    contents.map((content) => {
      if (content.type === "image" && content.url) {
        return resolveImageContent(content, options?.fetchImpl);
      }
      return Promise.resolve(content);
    })
  );
}

async function resolveImageContent(
  content: ImMessageContent & { type: "image" },
  fetchImpl?: FetchLike
): Promise<ImMessageContent> {
  const fetchFn = fetchImpl ?? fetch;
  try {
    const response = await fetchFn(content.url);
    if (!response.ok) {
      return { type: "text", text: "[图片: 下载失败]" };
    }
    return content;
  } catch {
    return { type: "text", text: "[图片: 下载失败]" };
  }
}
