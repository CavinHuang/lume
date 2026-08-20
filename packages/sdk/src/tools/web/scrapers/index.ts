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
import { handleOpenCorporates } from "./opencorporates.js";
import { handleOpenLibrary } from "./openlibrary.js";
import { handleOrcid } from "./orcid.js";
import { handleOsv } from "./osv.js";
import { handlePackagist } from "./packagist.js";
import { handlePubDev } from "./pub-dev.js";
import { handlePubMed } from "./pubmed.js";
import { handlePyPI } from "./pypi.js";
import { handleRawg } from "./rawg.js";
import { handleReadTheDocs } from "./readthedocs.js";
import { handleReddit } from "./reddit.js";
import { handleRepology } from "./repology.js";
import { handleRfc } from "./rfc.js";
import { handleRubyGems } from "./rubygems.js";
import { handleSearchcode } from "./searchcode.js";
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
	handleOpenCorporates,
	handleOpenLibrary,
	handleOpenVsx,
	handleOrcid,
	handleOsv,
	handlePackagist,
	handlePubDev,
	handlePubMed,
	handlePyPI,
	handleRawg,
	handleReadTheDocs,
	handleReddit,
	handleRepology,
	handleRfc,
	handleRubyGems,
	handleSearchcode,
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

export const specialHandlers: SpecialHandler[] = [
	// Git hosting
	handleGitHubGist,
	handleGitHub,
	handleGitLab,
	// Video/Media
	handleYouTube,
	handleVimeo,
	handleSpotify,
	handleDiscogs,
	handleMusicBrainz,
	// Games
	handleRawg,
	// Social/News
	handleTwitter,
	handleBluesky,
	handleMastodon,
	handleLemmy,
	handleHackerNews,
	handleLobsters,
	handleReddit,
	handleDiscourse,
	// Developer content
	handleStackOverflow,
	handleDevTo,
	handleMDN,
	handleDocsRs,
	handleReadTheDocs,
	handleSearchcode,
	handleSourcegraph,
	handleTldr,
	handleCheatSh,
	// Package registries
	handleNpm,
	handleFirefoxAddons,
	handleVscodeMarketplace,
	handleNuGet,
	handleChocolatey,
	handleClojars,
	handleBrew,
	handlePyPI,
	handleCratesIo,
	handleDockerHub,
	handleFdroid,
	handleFlathub,
	handleGoPkg,
	handleHex,
	handlePackagist,
	handlePubDev,
	handleMaven,
	handleJetBrainsMarketplace,
	handleOpenVsx,
	handleArtifactHub,
	handleRubyGems,
	handleTerraform,
	handleAur,
	handleHackage,
	handleMetaCPAN,
	handleRepology,
	handleSnapcraft,
	// ML/AI
	handleHuggingFace,
	handleOllama,
	// Academic
	handleArxiv,
	handleBiorxiv,
	handleCrossref,
	handleIacr,
	handleOrcid,
	handleSemanticScholar,
	handlePubMed,
	handleRfc,
	// Security
	handleCisaKev,
	handleNvd,
	handleOsv,
	// Crypto
	handleCoinGecko,
	// Business
	handleOpenCorporates,
	handleSecEdgar,
	// Reference
	handleOpenLibrary,
	handleChooseALicense,
	handleW3c,
	handleSpdx,
	handleWikidata,
	handleWikipedia,
];



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

export const specialHandlerNames = [
  "github-gist", "github", "gitlab", "youtube", "vimeo", "spotify", "discogs", "musicbrainz", "rawg",
  "twitter", "bluesky", "mastodon", "lemmy", "hackernews", "lobsters", "reddit", "discourse",
  "stackoverflow", "devto", "mdn", "docs-rs", "readthedocs", "searchcode", "sourcegraph", "tldr", "cheatsh",
  "npm", "firefox-addons", "vscode-marketplace", "nuget", "chocolatey", "clojars", "brew", "pypi", "crates-io",
  "dockerhub", "fdroid", "flathub", "go-pkg", "hex", "packagist", "pub-dev", "maven", "jetbrains-marketplace",
  "open-vsx", "artifacthub", "rubygems", "terraform", "aur", "hackage", "metacpan", "repology", "snapcraft",
  "huggingface", "ollama", "arxiv", "biorxiv", "crossref", "iacr", "orcid", "semantic-scholar", "pubmed", "rfc",
  "cisa-kev", "nvd", "osv", "coingecko", "opencorporates", "sec-edgar", "openlibrary", "choosealicense", "w3c",
  "spdx", "wikidata", "wikipedia",
] as const;

export async function handleSpecialUrl(url: string, context: ScraperContext): Promise<RenderResult | null> {
  const timeout = Math.max(0.001, context.timeoutMs / 1000);
  return runWithScraperRuntime({ fetchImpl: context.fetchImpl, sandbox: context.sandbox, storage: context.storage }, async () => {
    for (const handler of specialHandlers) {
      try {
        const result = await handler(url, timeout, context.signal, context.storage);
        if (result) return result;
      } catch (error) {
        if (context.signal?.aborted) throw error;
      }
    }
    return null;
  });
}
