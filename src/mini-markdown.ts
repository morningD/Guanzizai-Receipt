/** 零依赖的迷你 Markdown 渲染器：先整体 HTML 转义再做结构解析，保证输出安全。支持标题/粗斜体/行内码/代码块/有序无序列表/引用/链接/分隔线。 */

const escapeHtml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const renderInline = (text: string): string => {
  const codes: string[] = [];
  let html = text.replace(/`([^`]+)`/g, (_, code: string) => {
    // 数字令牌不含任何 markdown 语法字符，确保行内码内容不被粗斜体等规则二次加工
    codes.push(`<code>${escapeHtml(code)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
  html = html.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  html = html.replace(/\u0000(\d+)\u0000/g, (_, index: string) => codes[Number(index)]);
  return html;
};

export function renderMarkdownToHtml(markdown: string): string {
  const lines = escapeHtml(markdown).replace(/\r\n?/g, "\n").split("\n");
  const blocks: string[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let quote: string[] = [];
  let code: { lang: string; lines: string[] } | null = null;

  const flushParagraph = () => {
    if (paragraph.length) blocks.push(`<p>${paragraph.map(renderInline).join("<br />")}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (list) {
      const tag = list.ordered ? "ol" : "ul";
      blocks.push(`<${tag}>${list.items.map((item) => `<li>${renderInline(item)}</li>`).join("")}</${tag}>`);
      list = null;
    }
  };
  const flushQuote = () => {
    if (quote.length) blocks.push(`<blockquote>${quote.map(renderInline).join("<br />")}</blockquote>`);
    quote = [];
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
    flushQuote();
  };

  for (const line of lines) {
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      if (code) {
        blocks.push(`<pre><code data-lang="${code.lang}">${code.lines.join("\n")}</code></pre>`);
        code = null;
      } else {
        flushAll();
        code = { lang: fence[1] ?? "", lines: [] };
      }
      continue;
    }
    if (code) {
      code.lines.push(line);
      continue;
    }
    if (!line.trim()) {
      flushAll();
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      flushAll();
      const level = heading[1].length;
      blocks.push(`<h${level + 2}>${renderInline(heading[2])}</h${level + 2}>`);
      continue;
    }
    if (/^(---+|\*\*\*+)\s*$/.test(line)) {
      flushAll();
      blocks.push("<hr />");
      continue;
    }
    const quoted = line.match(/^>\s?(.*)$/);
    if (quoted) {
      flushParagraph();
      flushList();
      quote.push(quoted[1]);
      continue;
    }
    flushQuote();
    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    if (unordered) {
      flushParagraph();
      if (!list || list.ordered) {
        flushList();
        list = { ordered: false, items: [] };
      }
      list.items.push(unordered[1]);
      continue;
    }
    const ordered = line.match(/^\s*\d+[.、)]\s+(.+)$/);
    if (ordered) {
      flushParagraph();
      if (!list || !list.ordered) {
        flushList();
        list = { ordered: true, items: [] };
      }
      list.items.push(ordered[1]);
      continue;
    }
    flushList();
    paragraph.push(line.trim());
  }
  if (code) blocks.push(`<pre><code data-lang="${code.lang}">${code.lines.join("\n")}</code></pre>`);
  flushAll();
  return blocks.join("\n");
}
