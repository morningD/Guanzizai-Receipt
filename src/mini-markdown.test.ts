import { describe, expect, it } from "vitest";
import { renderMarkdownToHtml } from "./mini-markdown";

describe("renderMarkdownToHtml", () => {
  it("先转义 HTML 再解析，防止注入", () => {
    expect(renderMarkdownToHtml('<script>alert(1)</script>')).toBe("<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
  });
  it("支持粗体、斜体、行内码", () => {
    expect(renderMarkdownToHtml("**结论** 与 *依据* 及 `CNY 7,415.40`")).toContain("<strong>结论</strong>");
    expect(renderMarkdownToHtml("**结论** 与 *依据*")).toContain("<em>依据</em>");
    expect(renderMarkdownToHtml("`a**b**c`")).toContain("<code>a**b**c</code>");
  });
  it("有序列表识别中文顿号与英文句点，粗体保留", () => {
    const html = renderMarkdownToHtml("1. **先给结论**\n2. 再给依据");
    expect(html).toContain("<ol>");
    expect(html).toContain("<li><strong>先给结论</strong></li>");
    expect(html).toContain("<li>再给依据</li>");
  });
  it("无序列表与标题", () => {
    expect(renderMarkdownToHtml("- 甲\n- 乙")).toContain("<ul>");
    expect(renderMarkdownToHtml("### 小结")).toContain("<h5>小结</h5>");
  });
  it("代码块整块输出且不再解析内部标记", () => {
    const html = renderMarkdownToHtml("```\n**not bold**\n```");
    expect(html).toContain("<pre><code");
    expect(html).toContain("**not bold**");
  });
  it("链接带安全属性", () => {
    const html = renderMarkdownToHtml("[官网](https://example.com)");
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });
});
