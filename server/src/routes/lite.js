import { Router } from 'express';
import * as repo from '../repo.js';
import { S } from '../settings.js';
import config from '../config.js';
import { CONVERTIBLE } from '../convert/index.js';

// A no-JavaScript, server-rendered catalog for browsers that cannot run the
// React app: the Kindle "experimental browser" (frozen WebKit 531 UA,
// single-core, e-ink), other ancient WebKit/IE, feature phones, or anyone
// who appends ?lite=1.

const router = Router();

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const CSS = `
  body{font-family:Georgia,'Times New Roman',serif;font-size:20px;line-height:1.45;
       color:#000;background:#fff;margin:0;padding:14px 16px 40px;}
  a{color:#000;}
  h1{font-size:24px;margin:.2em 0 .4em;}
  h2{font-size:21px;margin:1em 0 .3em;border-bottom:2px solid #000;padding-bottom:2px;}
  .bar{border-bottom:3px solid #000;padding-bottom:10px;margin-bottom:12px;}
  .bar a{margin-right:14px;text-decoration:none;font-weight:bold;}
  form{margin:0 0 10px;}
  input[type=text]{font-size:20px;padding:8px;width:64%;border:2px solid #000;}
  input[type=submit],.btn{font-size:19px;padding:8px 14px;border:2px solid #000;background:#fff;
       display:inline-block;text-decoration:none;margin:3px 6px 3px 0;}
  ul.list{list-style:none;margin:0;padding:0;}
  ul.list li{padding:12px 0;border-bottom:1px solid #999;}
  .muted{color:#333;font-size:16px;}
  .row{overflow:hidden;}
  .cover{float:left;margin:0 14px 10px 0;border:1px solid #000;width:120px;}
  .dl a{font-weight:bold;}
  .pager{margin-top:16px;font-size:19px;}
  .pager a{border:2px solid #000;padding:6px 12px;text-decoration:none;margin-right:8px;}
  .note{font-size:15px;color:#333;margin-top:24px;border-top:1px solid #999;padding-top:8px;}
`;

function page(title, body) {
  return `<!doctype html>
<html><head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head><body>
<div class="bar">
  <a href="/lite">Home</a>
  <a href="/lite/books">Books</a>
  <a href="/lite/authors">Authors</a>
  <a href="/lite/series">Series</a>
  <a href="/lite/genres">Genres</a>
  <a href="/lite/catalogs">Catalogs</a>
</div>
${body}
<p class="note">Lite mode (no JavaScript). <a href="/?lite=0">Switch to the full site</a>.</p>
</body></html>`;
}

const send = (res, title, body) => res.type('html').send(page(title, body));

function searchForm(q = '') {
  return `<form action="/lite/search" method="get">
    <input type="text" name="q" value="${esc(q)}" placeholder="author, title or series">
    <input type="submit" value="Search">
  </form>`;
}

function pager(meta, urlFor) {
  if (!meta || meta.pages <= 1) return '';
  const parts = [];
  if (meta.has_prev) parts.push(`<a href="${urlFor(meta.page - 1)}">&laquo; Prev</a>`);
  parts.push(`<span>Page ${meta.page} / ${meta.pages}</span>`);
  if (meta.has_next) parts.push(`<a href="${urlFor(meta.page + 1)}">Next &raquo;</a>`);
  return `<p class="pager">${parts.join(' ')}</p>`;
}

const authorNames = (b) => b.authors.map((a) => a.full_name).join(', ') || '—';

function bookLi(b) {
  return `<li>
    <a href="/lite/book/${b.id}"><b>${esc(b.title)}</b></a>
    <div class="muted">${esc(authorNames(b))}${
      b.series && b.series[0] ? ` &middot; ${esc(b.series[0].ser)}` : ''
    } &middot; ${esc((b.format || '').toUpperCase())}</div>
  </li>`;
}

function bookList(title, data, urlFor, extra = '') {
  const body = `<h1>${esc(title)}</h1>${extra}
    ${
      data.items.length
        ? `<ul class="list">${data.items.map(bookLi).join('')}</ul>`
        : '<p>Nothing found.</p>'
    }
    ${pager(data, urlFor)}`;
  return body;
}

const pageNum = (req) => Math.max(1, parseInt(req.query.page, 10) || 1);

// ---- routes ----------------------------------------------------------

router.get('/', (req, res) => {
  const s = repo.stats();
  send(
    res,
    S.title,
    `<h1>${esc(S.title)}</h1>
     <p class="muted">${esc(S.subtitle || '')}</p>
     ${searchForm()}
     <p>${s.allbooks || 0} books &middot; ${s.allauthors || 0} authors &middot; ${
       s.allseries || 0
     } series &middot; ${s.allgenres || 0} genres</p>`,
  );
});

router.get('/search', (req, res) => {
  const q = (req.query.q || '').toString().trim();
  const type = (req.query.type || 'all').toString();
  const page = pageNum(req);
  if (!q) return send(res, 'Search', `<h1>Search</h1>${searchForm()}`);

  if (type === 'books') {
    return send(
      res,
      `Books: ${q}`,
      searchForm(q) +
        bookList(`Books matching “${q}”`, repo.searchBooks(q, { page }), (p) =>
          `/lite/search?type=books&q=${encodeURIComponent(q)}&page=${p}`,
        ),
    );
  }
  if (type === 'authors') {
    const d = repo.searchAuthors(q, { page });
    return send(
      res,
      `Authors: ${q}`,
      searchForm(q) +
        `<h1>Authors matching “${esc(q)}”</h1>
        <ul class="list">${d.items
          .map(
            (a) =>
              `<li><a href="/lite/author/${a.id}">${esc(a.full_name)}</a> <span class="muted">(${a.book_count})</span></li>`,
          )
          .join('')}</ul>` +
        pager(d, (p) => `/lite/search?type=authors&q=${encodeURIComponent(q)}&page=${p}`),
    );
  }
  if (type === 'series') {
    const d = repo.searchSeries(q, { page });
    return send(
      res,
      `Series: ${q}`,
      searchForm(q) +
        `<h1>Series matching “${esc(q)}”</h1>
        <ul class="list">${d.items
          .map(
            (x) =>
              `<li><a href="/lite/serie/${x.id}">${esc(x.ser)}</a> <span class="muted">(${x.book_count})</span></li>`,
          )
          .join('')}</ul>` +
        pager(d, (p) => `/lite/search?type=series&q=${encodeURIComponent(q)}&page=${p}`),
    );
  }

  const r = repo.searchAll(q);
  const section = (label, count, moreType, inner) =>
    `<h2>${label} <span class="muted">(${count})</span></h2>${inner}${
      count > 5
        ? `<p><a class="btn" href="/lite/search?type=${moreType}&q=${encodeURIComponent(q)}">All ${count} ${moreType} &raquo;</a></p>`
        : ''
    }`;
  send(
    res,
    `Search: ${q}`,
    searchForm(q) +
      `<h1>Results for “${esc(q)}”</h1>` +
      section(
        'Authors',
        r.authors.total,
        'authors',
        r.authors.items.length
          ? `<ul class="list">${r.authors.items
              .map(
                (a) =>
                  `<li><a href="/lite/author/${a.id}">${esc(a.full_name)}</a> <span class="muted">(${a.book_count})</span></li>`,
              )
              .join('')}</ul>`
          : '<p>None.</p>',
      ) +
      section(
        'Series',
        r.series.total,
        'series',
        r.series.items.length
          ? `<ul class="list">${r.series.items
              .map(
                (x) =>
                  `<li><a href="/lite/serie/${x.id}">${esc(x.ser)}</a> <span class="muted">(${x.book_count})</span></li>`,
              )
              .join('')}</ul>`
          : '<p>None.</p>',
      ) +
      section(
        'Books',
        r.books.total,
        'books',
        r.books.items.length
          ? `<ul class="list">${r.books.items.map(bookLi).join('')}</ul>`
          : '<p>None.</p>',
      ),
  );
});

router.get('/books', (req, res) => {
  const prefix = (req.query.prefix || '').toString();
  const page = pageNum(req);
  const d = repo.listBooks({ prefix, page });
  send(
    res,
    'Books',
    bookList(
      'Books',
      d,
      (p) => `/lite/books?prefix=${encodeURIComponent(prefix)}&page=${p}`,
      `<form action="/lite/books" method="get">
        <input type="text" name="prefix" value="${esc(prefix)}" placeholder="title starts with">
        <input type="submit" value="Go">
      </form>`,
    ),
  );
});

router.get('/book/:id', (req, res) => {
  const b = repo.getBook(Number(req.params.id));
  if (!b) return res.status(404).type('html').send(page('Not found', '<h1>Not found</h1>'));
  const fmts = [
    b.format,
    ...config.downloadFormats.filter(
      (f) => f !== b.format && CONVERTIBLE.includes(b.format),
    ),
  ];
  const dl = fmts
    .map(
      (f) =>
        `<a class="btn" href="/api/books/${b.id}/download?format=${f}">${f.toUpperCase()}${
          f === b.format ? '' : ' (convert)'
        }</a>`,
    )
    .join('');
  send(
    res,
    b.title,
    `<div class="row">
      <img class="cover" src="/api/books/${b.id}/cover?eink=1" alt="">
      <h1>${esc(b.title)}</h1>
      <p>${b.authors
        .map((a) => `<a href="/lite/author/${a.id}">${esc(a.full_name)}</a>`)
        .join(', ') || '—'}</p>
      ${b.series
        .map(
          (x) =>
            `<p class="muted">Series: <a href="/lite/serie/${x.id}">${esc(x.ser)}</a>${
              x.ser_no ? ` #${x.ser_no}` : ''
            }</p>`,
        )
        .join('')}
      <p class="muted">${esc((b.format || '').toUpperCase())} &middot; ${Math.round(
        (b.filesize || 0) / 1024,
      )} KB${b.doc_date ? ` &middot; ${esc(b.doc_date)}` : ''}${
        b.lang ? ` &middot; ${esc(b.lang)}` : ''
      }</p>
      <p class="dl">${dl}</p>
      ${b.genres.length ? `<p class="muted">${b.genres.map((g) => esc(g.subsection)).join(', ')}</p>` : ''}
    </div>
    ${b.annotation ? `<p>${esc(b.annotation)}</p>` : ''}`,
  );
});

function letterBrowse(kind, req, res) {
  const prefix = (req.query.prefix || '').toString();
  const page = pageNum(req);
  const fn = kind === 'authors' ? repo.listAuthors : repo.listSeries;
  const d = fn({ prefix, page });
  const linkBase = kind === 'authors' ? '/lite/author/' : '/lite/serie/';
  const nameKey = kind === 'authors' ? 'full_name' : 'ser';
  send(
    res,
    kind === 'authors' ? 'Authors' : 'Series',
    `<h1>${kind === 'authors' ? 'Authors' : 'Series'}</h1>
     <form action="/lite/${kind}" method="get">
       <input type="text" name="prefix" value="${esc(prefix)}" placeholder="starts with">
       <input type="submit" value="Go">
     </form>
     <ul class="list">${d.items
       .map(
         (x) =>
           `<li><a href="${linkBase}${x.id}">${esc(x[nameKey])}</a> <span class="muted">(${x.book_count})</span></li>`,
       )
       .join('')}</ul>
     ${pager(d, (p) => `/lite/${kind}?prefix=${encodeURIComponent(prefix)}&page=${p}`)}`,
  );
}
router.get('/authors', (req, res) => letterBrowse('authors', req, res));
router.get('/series', (req, res) => letterBrowse('series', req, res));

router.get('/author/:id', (req, res) => {
  const id = Number(req.params.id);
  const page = pageNum(req);
  const d = repo.booksByAuthor(id, { page });
  const name = d.items[0]?.authors.find((a) => a.id === id)?.full_name || 'Author';
  send(
    res,
    name,
    bookList(name, d, (p) => `/lite/author/${id}?page=${p}`),
  );
});

router.get('/serie/:id', (req, res) => {
  const id = Number(req.params.id);
  const page = pageNum(req);
  const d = repo.booksBySeries(id, { page });
  const name = d.items[0]?.series.find((x) => x.id === id)?.ser || 'Series';
  send(
    res,
    name,
    bookList(name, d, (p) => `/lite/serie/${id}?page=${p}`),
  );
});

router.get('/genres', (req, res) => {
  const section = Number(req.query.section) || 0;
  if (!section) {
    const list = repo.genreSections();
    return send(
      res,
      'Genres',
      `<h1>Genres</h1><ul class="list">${list
        .map(
          (g) =>
            `<li><a href="/lite/genres?section=${g.section_id}">${esc(g.section)}</a> <span class="muted">(${g.book_count})</span></li>`,
        )
        .join('')}</ul>`,
    );
  }
  const list = repo.genresInSection(section);
  send(
    res,
    'Genre',
    `<h1>Genres</h1><ul class="list">${list
      .map(
        (g) =>
          `<li><a href="/lite/genre/${g.id}">${esc(g.subsection)}</a> <span class="muted">(${g.book_count})</span></li>`,
      )
      .join('')}</ul>`,
  );
});

router.get('/genre/:id', (req, res) => {
  const id = Number(req.params.id);
  const page = pageNum(req);
  send(
    res,
    'Genre',
    bookList('Books in genre', repo.booksByGenre(id, { page }), (p) => `/lite/genre/${id}?page=${p}`),
  );
});

router.get('/catalogs', (req, res) => {
  const cat = req.query.cat ? Number(req.query.cat) : repo.rootCatalogId();
  const page = pageNum(req);
  const crumbs = repo.catalogBreadcrumbs(cat);
  const kids = repo.childCatalogs(cat);
  const books = repo.booksByCatalog(cat, { page });
  send(
    res,
    'Catalogs',
    `<h1>Catalogs</h1>
     <p class="muted">${['<a href="/lite/catalogs">ROOT</a>', ...crumbs.map((c) => `<a href="/lite/catalogs?cat=${c.id}">${esc(c.name)}</a>`)].join(' / ')}</p>
     ${
       kids.length
         ? `<ul class="list">${kids
             .map(
               (c) =>
                 `<li><a href="/lite/catalogs?cat=${c.id}">${esc(c.cat_name)}/</a> <span class="muted">(${c.book_count})</span></li>`,
             )
             .join('')}</ul>`
         : ''
     }
     ${books.items.length ? `<ul class="list">${books.items.map(bookLi).join('')}</ul>` : ''}
     ${pager(books, (p) => `/lite/catalogs?cat=${cat}&page=${p}`)}`,
  );
});

// eslint-disable-next-line no-unused-vars
router.use((err, req, res, _next) => {
  console.error('lite route error:', err);
  res
    .status(500)
    .type('html')
    .send(page('Error', `<h1>Something went wrong</h1><p>${esc(err.message)}</p>`));
});

export default router;
