import { describe, expect, test } from "bun:test";
import { linkCategoryIdFromFilter, matchesLinkCategory } from "./link-category-filters";

describe("Link category filters", () => {
  test("combines the OpenConnector taxonomy into user-facing facets", () => {
    expect(matchesLinkCategory(["Productivity"], "productivity")).toBe(true);
    expect(matchesLinkCategory(["Project Management"], "productivity")).toBe(true);
    expect(matchesLinkCategory(["Data"], "data-storage")).toBe(true);
    expect(matchesLinkCategory(["Storage"], "data-storage")).toBe(true);
  });

  test("places unmapped and uncategorized providers in Other", () => {
    expect(matchesLinkCategory([], "other")).toBe(true);
    expect(matchesLinkCategory(["Unmapped"], "other")).toBe(true);
    expect(matchesLinkCategory(["AI", "Unmapped"], "other")).toBe(false);
  });

  test("parses only known category filter values", () => {
    expect(linkCategoryIdFromFilter("category:communication")).toBe("communication");
    expect(linkCategoryIdFromFilter("all")).toBeNull();
    expect(linkCategoryIdFromFilter("category:missing")).toBeNull();
  });
});
