import test from 'node:test';
import assert from 'node:assert/strict';
import { esc, renderMarkdown } from '../public/markdown.js';

const NUL = String.fromCharCode(0);

test('markdown output never contains live HTML from message content', () => {
  const html = renderMarkdown('XSS <script>alert(1)</script> and <img src=x onerror=alert(2)>');
  assert.doesNotMatch(html, /<script/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('fenced code, inline code, bold, headings, and links render', () => {
  const html = renderMarkdown('## Plan\n**bold** `inline` [docs](https://example.com/a?b=1)\n```js\nconst x = 1 < 2;\n```');
  assert.match(html, /<span class="md-heading">Plan<\/span>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<code class="md-inline">inline<\/code>/);
  assert.match(html, /<a href="https:\/\/example.com\/a\?b=1" target="_blank" rel="noopener noreferrer">docs<\/a>/);
  assert.match(html, /<div class="md-code-head"><span>js<\/span>/);
  assert.match(html, /const x = 1 &lt; 2;/);
  assert.match(html, /data-copy-code="1"/);
});

test('a stashed snippet cannot be restored inside an href attribute', () => {
  // Review finding: inline code inside a link URL used to smuggle the snippet
  // token into href, breaking out of the attribute on restore.
  const html = renderMarkdown('click [here](https://example.com/`x`)');
  assert.doesNotMatch(html, /<a /, 'a URL containing a snippet token must not become an anchor');
  assert.match(html, /<code class="md-inline">x<\/code>/, 'the inline code still renders as text content');
  assert.doesNotMatch(html, /href/);
});

test('attacker-supplied NUL sentinels are stripped, not treated as tokens', () => {
  const forged = renderMarkdown(`${NUL}0${NUL} then: \`\`\`js\nSAFE\n\`\`\``);
  assert.equal(forged.match(/md-code-head/g).length, 1, 'a forged in-range token must not duplicate a snippet');
  const dangling = renderMarkdown(`plain ${NUL}99${NUL} text`);
  assert.match(dangling, /plain 99 text/, 'a forged out-of-range token must not delete surrounding digits');
  assert.equal(forged.includes(NUL), false);
});

test('pathological unmatched brackets stay linear and produce no anchors', () => {
  // Fleet-review finding: an unmatched-[ flood drove the link pass quadratic
  // (~50ms per 12K message) before the text class excluded [ and got bounded.
  const hostile = '['.repeat(12_000);
  const startedAt = process.hrtime.bigint();
  const html = renderMarkdown(hostile);
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  assert.doesNotMatch(html, /<a /);
  assert.ok(elapsedMs < 250, `link pass must not go quadratic (took ${elapsedMs.toFixed(1)}ms)`);
});

test('plain text with numbers, asterisks, and brackets passes through intact', () => {
  const html = renderMarkdown('there are 3 things left and 12 done; a[0] * b[1] is fine');
  assert.match(html, /there are 3 things left and 12 done/);
  assert.match(html, /a\[0\] \* b\[1\] is fine/);
});

test('esc escapes all HTML-sensitive characters', () => {
  assert.equal(esc('<a href="x" title=\'y\'>&'), '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;');
});
