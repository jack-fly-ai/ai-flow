import { describe, expect, it } from "vitest";
import { escapeHtml, renderFallbackMarkdown, renderMarkdown } from "@/lib/markdown";

/* The doc tabs render markdown through dangerouslySetInnerHTML, so the escape
 * path is the security boundary for user-controlled ticket content. These are
 * the runtime counterparts of the node-suite XSS regression test
 * (test/units-init-runner.test.ts) — the React side now has its own guard. */

describe("escapeHtml", () => {
  it("escapes every HTML-significant character", () => {
    expect(escapeHtml(`<script>alert("x")</script>`)).toBe("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(escapeHtml("a & b 'c'")).toBe("a &amp; b &#39;c&#39;");
  });
});

describe("renderFallbackMarkdown", () => {
  it("never lets a raw <script> through", () => {
    const html = renderFallbackMarkdown("<script>alert(1)</script>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders emphasis and headings around escaped content", () => {
    const html = renderFallbackMarkdown("# Title\n**bold** and `code`");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<b>bold</b>");
    expect(html).toContain("<code>code</code>");
  });
});

describe("renderMarkdown", () => {
  it("escapes inline HTML (the dangerouslySetInnerHTML boundary)", () => {
    const html = renderMarkdown("<img src=x onerror=alert(1)>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("escapes script tags inside code fences too", () => {
    const html = renderMarkdown("```\n<script>alert(1)</script>\n```");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders a fenced block as <pre><code>", () => {
    const html = renderMarkdown("```\nplain code\n```");
    expect(html).toContain("<pre><code>plain code</code></pre>");
  });

  it("renders headings, lists and paragraphs", () => {
    const html = renderMarkdown("## Head\n\n- one\n- two\n\nA paragraph.");
    expect(html).toContain("<h2>Head</h2>");
    expect(html).toContain("<ul><li>one</li><li>two</li></ul>");
    expect(html).toContain("<p>A paragraph.</p>");
  });

  it("never renders 'undefined' when the source contains a fence sentinel", () => {
    /* The PUA sentinels (\uE000F<n>\uE000) mark fence positions; a document
     * that literally contains one must render its escaped literal, never the
     * string "undefined". */
    const html = renderMarkdown("\uE000F0\uE000");
    expect(html).not.toContain("undefined");
    expect(html).toContain("\uE000");
  });
});
