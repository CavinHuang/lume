import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { FilePromotionCard } from "./FilePromotionCard";

describe("FilePromotionCard", () => {
  test("应展示推荐提升标题与文件名", () => {
    const html = renderToString(
      <FilePromotionCard
        files={[{ path: "report.md", name: "report.md", status: "suggested" }]}
        onPromote={() => undefined}
        onPromoteAll={() => undefined}
        onDismiss={() => undefined}
      />
    );

    expect(html).toContain("这些文件可能值得沉淀到工作区共享文件");
    expect(html).toContain("report.md");
    expect(html).toContain("提升");
  });

  test("已提升文件应显示状态标签", () => {
    const html = renderToString(
      <FilePromotionCard
        files={[{ path: "report.md", name: "report.md", status: "promoted" }]}
        onPromote={() => undefined}
        onPromoteAll={() => undefined}
        onDismiss={() => undefined}
      />
    );

    expect(html).toContain("已提升");
  });
});
