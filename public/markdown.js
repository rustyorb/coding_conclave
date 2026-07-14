export const esc = (value = '') => String(value).replace(/[&<>'"]/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
})[character]);

// Minimal markdown for the chat feed. Safety model: NULs are stripped from the
// input (they are reserved as stash sentinels), code is escaped and stashed
// first so no other transform reaches inside it, then everything else is escaped
// before the remaining patterns run — raw content never touches innerHTML. The
// URL class excludes the sentinel so a stashed snippet can never be restored
// inside an href attribute.
export function renderMarkdown(raw) {
  const snippets = [];
  const stash = (html) => `\u0000${snippets.push(html) - 1}\u0000`;
  const text = String(raw ?? '').replace(/\u0000/g, '')
    .replace(/```([\w-]*)[^\S\n]*\n([\s\S]*?)```\n?/g, (match, lang, code) => stash(
      `<div class="md-code"><div class="md-code-head"><span>${esc(lang || 'code')}</span><button class="code-copy" data-copy-code="1" title="Copy code">Copy</button></div><pre><code>${esc(code.replace(/\n$/, ''))}</code></pre></div>`
    ))
    .replace(/`([^`\n]+)`/g, (match, code) => stash(`<code class="md-inline">${esc(code)}</code>`));
  return esc(text)
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\n)#{1,4}[^\S\n]+([^\n]+)/g, '$1<span class="md-heading">$2</span>')
    .replace(/\[([^\[\]\n]{1,400})\]\((https?:\/\/[^)\s\u0000]{1,2000})\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/\u0000(\d+)\u0000/g, (match, index) => snippets[Number(index)] ?? '');
}
