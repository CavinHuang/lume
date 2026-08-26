// @ts-nocheck
import { ToolAbortError } from "./compat.js";
import type { RenderResult, SpecialHandler } from "./types.js";

/**
 * Twitter/X handler：x.com 对自动化访问全面封锁，公共 Nitter 实例也已大面积死亡。
 * 保留显式 blocked 提示并终止 handler 链（优于落回通用抓取的必然失败），不再白打请求。
 */
export const handleTwitter: SpecialHandler = async (
	url: string,
	_timeout: number,
	signal?: AbortSignal,
): Promise<RenderResult | null> => {
	const parsed = new URL(url);
	if (!["twitter.com", "x.com", "www.twitter.com", "www.x.com"].includes(parsed.hostname)) {
		return null;
	}
	if (signal?.aborted) {
		throw new ToolAbortError();
	}
	return {
		url,
		finalUrl: url,
		contentType: "text/plain",
		method: "twitter-blocked",
		content:
			"Twitter/X blocks automated access.\n\nTry:\n- Opening the link in a browser\n- Checking if the tweet is available via an archive service",
		fetchedAt: new Date().toISOString(),
		truncated: false,
		notes: ["X.com blocks bots"],
	};
};
