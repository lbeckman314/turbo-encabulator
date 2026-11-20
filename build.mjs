// Renders post.md into index.html, between the <!-- post:start --> and
// <!-- post:end --> markers. Everything outside the markers is left alone.
//
//   npm run build   build once
//   npm run dev     rebuild whenever post.md or a partial changes
//
// Markdown extras:
//   front matter      title, date (YYYY-MM-DD) and tags (comma-separated)
//   @include <path>   on its own line: pastes in an HTML partial (figures etc.)
//   ::: callout Label  a boxed aside with a label, closed by :::
//   ## Heading {#id}  sets the heading's id
// Raw HTML (e.g. <var>) is allowed anywhere.
import { readFileSync, writeFileSync, watch } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import MarkdownIt from 'markdown-it';
import container from 'markdown-it-container';
import attrs from 'markdown-it-attrs';

const root = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(root, 'post.md');
const PAGE = join(root, 'index.html');
const START = '<!-- post:start -->';
const END = '<!-- post:end -->';

const md = new MarkdownIt({ html: true });
// Only {#id} and {.class} after headings etc.; keeps `{ … }` in prose literal.
md.use(attrs, { allowedAttributes: ['id', 'class'] });
md.use(container, 'callout', {
  validate: (params) => /^callout\b/.test(params.trim()),
  render: (tokens, i) => {
    if (tokens[i].nesting !== 1) return '</aside>\n';
    const label = tokens[i].info.trim().replace(/^callout\s*/, '');
    return `<aside class="callout">\n${label ? `<div class="callout-label">${md.utils.escapeHtml(label)}</div>\n` : ''}`;
  },
});
// Tables scroll sideways on narrow screens inside .table-wrap.
md.renderer.rules.table_open = () => '<div class="table-wrap">\n<table>\n';
md.renderer.rules.table_close = () => '</table>\n</div>\n';

function frontMatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return { meta: {}, body: text };
  const meta = Object.fromEntries(
    m[1].split('\n').filter((l) => l.includes(':')).map((l) => {
      const i = l.indexOf(':');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
  );
  return { meta, body: text.slice(m[0].length) };
}

function header({ title, date, tags }) {
  const esc = md.utils.escapeHtml;
  const when = date
    ? `<time datetime="${esc(date)}">${new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', {
        month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC',
      })}</time>`
    : '';
  const tagList = (tags || '').split(',').map((t) => t.trim()).filter(Boolean);
  const tagSpan = tagList.length ? `\n    <span class="tags">${tagList.map((t) => `#${esc(t)}`).join(' ')}</span>` : '';
  return `<header class="post-head">
  <h1>${esc(title || '')}</h1>
  <div class="meta">
    ${when}${tagSpan}
  </div>
</header>
`;
}

function build() {
  const { meta, body } = frontMatter(readFileSync(SOURCE, 'utf8'));
  // @include lines become the partial's HTML (a blank line either side keeps
  // markdown-it treating it as a block of raw HTML).
  const expanded = body.replace(/^@include\s+(\S+)\s*$/gm, (_, p) => `\n${readFileSync(join(root, p), 'utf8').trim()}\n`);
  const html = header(meta) + '\n' + md.render(expanded);

  const page = readFileSync(PAGE, 'utf8');
  const a = page.indexOf(START), b = page.indexOf(END);
  if (a < 0 || b < a) throw new Error(`index.html needs ${START} … ${END} markers`);
  const indent = page.slice(page.lastIndexOf('\n', a) + 1, a);
  const out = page.slice(0, a + START.length) + '\n' +
    html.trimEnd().split('\n').map((l) => (l ? indent + l : l)).join('\n') + '\n' +
    indent + page.slice(b);
  if (out !== page) writeFileSync(PAGE, out);
  console.log(`${new Date().toLocaleTimeString()}  built index.html from post.md${out === page ? ' (no change)' : ''}`);
}

build();

if (process.argv.includes('--watch')) {
  let timer;
  const again = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try { build(); } catch (e) { console.error(e.message); }
    }, 80);
  };
  watch(SOURCE, again);
  watch(join(root, 'partials'), again);
  console.log('watching post.md and partials/ …');
}
