import { describe, expect, test } from "bun:test";
import { LINK_CATEGORY_FILTERS, linkCategoryIdFromFilter, matchesLinkCategory } from "./link-category-filters";

describe("Link category filters", () => {
  test("combines the OpenConnector taxonomy into user-facing facets", () => {
    expect(matchesLinkCategory("notion", ["Productivity"], "productivity")).toBe(true);
    expect(matchesLinkCategory("linear", ["Project Management"], "productivity")).toBe(true);
    expect(matchesLinkCategory("airtable", ["Data"], "data-storage")).toBe(true);
    expect(matchesLinkCategory("dropbox", ["Storage"], "data-storage")).toBe(true);
  });

  test("keeps cross-border commerce as a curated primary facet", () => {
    expect(LINK_CATEGORY_FILTERS.filter((category) => category.primary).map((category) => category.label)).toEqual([
      "跨境电商",
      "AI",
      "效率",
    ]);
    expect(matchesLinkCategory("shopify_admin", ["Marketing", "Data"], "cross-border-commerce")).toBe(true);
    expect(matchesLinkCategory("aftership", ["Productivity", "Location"], "cross-border-commerce")).toBe(true);
    expect(matchesLinkCategory("mailchimp", ["Marketing"], "cross-border-commerce")).toBe(false);
  });

  test("places unmapped and uncategorized providers in Other", () => {
    expect(matchesLinkCategory("uncategorized", [], "other")).toBe(true);
    expect(matchesLinkCategory("unmapped", ["Unmapped"], "other")).toBe(true);
    expect(matchesLinkCategory("openai", ["AI", "Unmapped"], "other")).toBe(false);
  });

  test("parses only known category filter values", () => {
    expect(linkCategoryIdFromFilter("category:communication")).toBe("communication");
    expect(linkCategoryIdFromFilter("all")).toBeNull();
    expect(linkCategoryIdFromFilter("category:missing")).toBeNull();
  });
});
