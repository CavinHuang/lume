/**
 * Web Fetch Special Handlers Index
 *
 * Exports all special handlers for site-specific content extraction.
 */
import { handleArtifactHub } from "./artifacthub.js";
import { handleArxiv } from "./arxiv.js";
import { handleAur } from "./aur.js";
import { handleBiorxiv } from "./biorxiv.js";
import { handleBluesky } from "./bluesky.js";
import { handleBrew } from "./brew.js";
import { handleCheatSh } from "./cheatsh.js";
import { handleChocolatey } from "./chocolatey.js";
import { handleChooseALicense } from "./choosealicense.js";
import { handleCisaKev } from "./cisa-kev.js";
import { handleClojars } from "./clojars.js";
import { handleCoinGecko } from "./coingecko.js";
import { handleCratesIo } from "./crates-io.js";
import { handleCrossref } from "./crossref.js";
import { handleDevTo } from "./devto.js";
import { handleDiscogs } from "./discogs.js";
import { handleDiscourse } from "./discourse.js";
import { handleDockerHub } from "./dockerhub.js";
import { handleDocsRs } from "./docs-rs.js";
import { handleFdroid } from "./fdroid.js";
import { handleFirefoxAddons } from "./firefox-addons.js";
import { handleFlathub } from "./flathub.js";
import { fetchGitHubApi, handleGitHub } from "./github.js";
import { handleGitHubGist } from "./github-gist.js";
import { handleGitLab } from "./gitlab.js";
import { handleGoPkg } from "./go-pkg.js";
import { handleHackage } from "./hackage.js";
import { handleHackerNews } from "./hackernews.js";
import { handleHex } from "./hex.js";
import { handleHuggingFace } from "./huggingface.js";
import { handleIacr } from "./iacr.js";
import { handleJetBrainsMarketplace } from "./jetbrains-marketplace.js";
import { handleLemmy } from "./lemmy.js";
import { handleLobsters } from "./lobsters.js";
import { handleMastodon } from "./mastodon.js";
import { handleMaven } from "./maven.js";
import { handleMDN } from "./mdn.js";
import { handleMetaCPAN } from "./metacpan.js";
import { handleMusicBrainz } from "./musicbrainz.js";
import { handleNpm } from "./npm.js";
import { handleNuGet } from "./nuget.js";
import { handleNvd } from "./nvd.js";
import { handleOllama } from "./ollama.js";
import { handleOpenVsx } from "./open-vsx.js";
import { handleOpenLibrary } from "./openlibrary.js";
import { handleOrcid } from "./orcid.js";
import { handleOsv } from "./osv.js";
import { handlePackagist } from "./packagist.js";
import { handlePubDev } from "./pub-dev.js";
import { handlePubMed } from "./pubmed.js";
import { handlePyPI } from "./pypi.js";
import { handleReadTheDocs } from "./readthedocs.js";
import { handleReddit } from "./reddit.js";
import { handleRepology } from "./repology.js";
import { handleRfc } from "./rfc.js";
import { handleRubyGems } from "./rubygems.js";
import { handleSecEdgar } from "./sec-edgar.js";
import { handleSemanticScholar } from "./semantic-scholar.js";
import { handleSnapcraft } from "./snapcraft.js";
import { handleSourcegraph } from "./sourcegraph.js";
import { handleSpdx } from "./spdx.js";
import { handleSpotify } from "./spotify.js";
import { handleStackOverflow } from "./stackoverflow.js";
import { handleTerraform } from "./terraform.js";
import { handleTldr } from "./tldr.js";
import { handleTwitter } from "./twitter.js";
import type { SpecialHandler } from "./types.js";
import { handleVimeo } from "./vimeo.js";
import { handleVscodeMarketplace } from "./vscode-marketplace.js";
import { handleW3c } from "./w3c.js";
import { handleWikidata } from "./wikidata.js";
import { handleWikipedia } from "./wikipedia.js";
import { handleYouTube } from "./youtube.js";

export type { RenderResult, SpecialHandler } from "./types.js";

export {
	fetchGitHubApi,
	handleArtifactHub,
	handleArxiv,
	handleAur,
	handleBiorxiv,
	handleBluesky,
	handleBrew,
	handleCheatSh,
	handleChocolatey,
	handleChooseALicense,
	handleCisaKev,
	handleClojars,
	handleCoinGecko,
	handleCratesIo,
	handleCrossref,
	handleDevTo,
	handleDiscogs,
	handleDiscourse,
	handleDockerHub,
	handleDocsRs,
	handleFdroid,
	handleFirefoxAddons,
	handleFlathub,
	handleGitHub,
	handleGitHubGist,
	handleGitLab,
	handleGoPkg,
	handleHackage,
	handleHackerNews,
	handleHex,
	handleHuggingFace,
	handleIacr,
	handleJetBrainsMarketplace,
	handleLemmy,
	handleLobsters,
	handleMastodon,
	handleMaven,
	handleMDN,
	handleMetaCPAN,
	handleMusicBrainz,
	handleNpm,
	handleNuGet,
	handleNvd,
	handleOllama,
	handleOpenLibrary,
	handleOpenVsx,
	handleOrcid,
	handleOsv,
	handlePackagist,
	handlePubDev,
	handlePubMed,
	handlePyPI,
	handleReadTheDocs,
	handleReddit,
	handleRepology,
	handleRfc,
	handleRubyGems,
	handleSecEdgar,
	handleSemanticScholar,
	handleSnapcraft,
	handleSourcegraph,
	handleSpdx,
	handleSpotify,
	handleStackOverflow,
	handleTerraform,
	handleTldr,
	handleTwitter,
	handleVimeo,
	handleVscodeMarketplace,
	handleW3c,
	handleWikidata,
	handleWikipedia,
	handleYouTube,
};

// 单表驱动（#540）：名字与 handler 同源派生，新增条目漏登名字不再可能。
// 表项顺序即 handleSpecialUrl 的探测顺序，勿随意重排。
const SPECIAL_HANDLER_TABLE: ReadonlyArray<readonly [string, SpecialHandler]> = [
	// Git hosting
	["github-gist", handleGitHubGist],
	["github", handleGitHub],
	["gitlab", handleGitLab],
	// Video/Media
	["youtube", handleYouTube],
	["vimeo", handleVimeo],
	["spotify", handleSpotify],
	["discogs", handleDiscogs],
	["musicbrainz", handleMusicBrainz],
	// Games
	// Social/News
	["twitter", handleTwitter],
	["bluesky", handleBluesky],
	["mastodon", handleMastodon],
	["lemmy", handleLemmy],
	["hackernews", handleHackerNews],
	["lobsters", handleLobsters],
	["reddit", handleReddit],
	["discourse", handleDiscourse],
	// Developer content
	["stackoverflow", handleStackOverflow],
	["devto", handleDevTo],
	["mdn", handleMDN],
	["docs-rs", handleDocsRs],
	["readthedocs", handleReadTheDocs],
	["sourcegraph", handleSourcegraph],
	["tldr", handleTldr],
	["cheatsh", handleCheatSh],
	// Package registries
	["npm", handleNpm],
	["firefox-addons", handleFirefoxAddons],
	["vscode-marketplace", handleVscodeMarketplace],
	["nuget", handleNuGet],
	["chocolatey", handleChocolatey],
	["clojars", handleClojars],
	["brew", handleBrew],
	["pypi", handlePyPI],
	["crates-io", handleCratesIo],
	["dockerhub", handleDockerHub],
	["fdroid", handleFdroid],
	["flathub", handleFlathub],
	["go-pkg", handleGoPkg],
	["hex", handleHex],
	["packagist", handlePackagist],
	["pub-dev", handlePubDev],
	["maven", handleMaven],
	["jetbrains-marketplace", handleJetBrainsMarketplace],
	["open-vsx", handleOpenVsx],
	["artifacthub", handleArtifactHub],
	["rubygems", handleRubyGems],
	["terraform", handleTerraform],
	["aur", handleAur],
	["hackage", handleHackage],
	["metacpan", handleMetaCPAN],
	["repology", handleRepology],
	["snapcraft", handleSnapcraft],
	// ML/AI
	["huggingface", handleHuggingFace],
	["ollama", handleOllama],
	// Academic
	["arxiv", handleArxiv],
	["biorxiv", handleBiorxiv],
	["crossref", handleCrossref],
	["iacr", handleIacr],
	["orcid", handleOrcid],
	["semantic-scholar", handleSemanticScholar],
	["pubmed", handlePubMed],
	["rfc", handleRfc],
	// Security
	["cisa-kev", handleCisaKev],
	["nvd", handleNvd],
	["osv", handleOsv],
	// Crypto
	["coingecko", handleCoinGecko],
	// Business
	["sec-edgar", handleSecEdgar],
	// Reference
	["openlibrary", handleOpenLibrary],
	["choosealicense", handleChooseALicense],
	["w3c", handleW3c],
	["spdx", handleSpdx],
	["wikidata", handleWikidata],
	["wikipedia", handleWikipedia],
];

export const specialHandlers: SpecialHandler[] = SPECIAL_HANDLER_TABLE.map(([, handler]) => handler);

export const specialHandlerNames = SPECIAL_HANDLER_TABLE.map(([name]) => name);



import { runWithScraperRuntime, type AgentStorage } from "./compat.js";
import type { RenderResult } from "./types.js";
import type { SandboxSettings } from "../../../types.js";
import type { FetchImpl } from "../../web-fetch-http.js";

export interface ScraperContext {
  timeoutMs: number;
  signal?: AbortSignal;
  sandbox?: SandboxSettings;
  fetchImpl: FetchImpl;
  storage?: AgentStorage | null;
}

export async function handleSpecialUrl(url: string, context: ScraperContext): Promise<RenderResult | null> {
  const timeout = Math.max(0.001, context.timeoutMs / 1000);
  // Aggregate budget: handlers used to each enjoy the full timeout, so a URL
  // nobody handles burned k×timeout before the generic fallback (#237).
  const deadline = Date.now() + context.timeoutMs;
  return runWithScraperRuntime({ fetchImpl: context.fetchImpl, sandbox: context.sandbox, storage: context.storage }, async () => {
    for (const handler of specialHandlers) {
      const remainingSec = (deadline - Date.now()) / 1000;
      if (remainingSec <= 0) return null;
      try {
        const result = await handler(url, Math.min(timeout, remainingSec), context.signal, context.storage);
        if (result) return result;
      } catch (error) {
        if (context.signal?.aborted) throw error;
      }
    }
    return null;
  });
}
