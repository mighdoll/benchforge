import { expect, test } from "vitest";
import { isLargeSource, plainSourceHtml } from "../viewer/SourceRender.ts";

test("small file is not large", () => {
  expect(isLargeSource("const a = 1;\nconst b = 2;\n")).toBe(false);
});

test("many lines trip the large guard", () => {
  const code = Array.from({ length: 5001 }, () => "x").join("\n");
  expect(isLargeSource(code)).toBe(true);
});

test("a single very long (minified) line trips the large guard", () => {
  const code = "a".repeat(2001);
  expect(isLargeSource(code)).toBe(true);
});

test("large total byte size trips the large guard", () => {
  // Under the line-count and line-length limits, but over the byte limit.
  const code = Array.from({ length: 400 }, () => "a".repeat(800)).join("\n");
  expect(code.length).toBeGreaterThan(300_000);
  expect(isLargeSource(code)).toBe(true);
});

test("plainSourceHtml emits one .line span per source line", () => {
  const html = plainSourceHtml("a\nb\nc");
  const count = html.match(/class="line"/g)?.length;
  expect(count).toBe(3);
});

test("plainSourceHtml escapes HTML metacharacters", () => {
  const html = plainSourceHtml('if (a < b && c > d) return "<x>";');
  expect(html).toContain("a &lt; b &amp;&amp; c &gt; d");
  expect(html).toContain("&lt;x&gt;");
});

test("plainSourceHtml wraps in the Shiki pre/code structure", () => {
  const html = plainSourceHtml("x");
  expect(html.startsWith('<pre class="shiki"><code>')).toBe(true);
  expect(html.endsWith("</code></pre>")).toBe(true);
});
