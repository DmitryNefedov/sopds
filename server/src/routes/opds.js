import { Router } from 'express';
import * as repo from '../repo.js';
import config from '../config.js';
import { mimeFor } from '../files.js';

// Minimal OPDS 1.1 (Atom) catalog so existing OPDS readers keep working.
const router = Router();

const xmlEscape = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const NAV = 'application/atom+xml;profile=opds-catalog;kind=navigation';
const ACQ = 'application/atom+xml;profile=opds-catalog;kind=acquisition';

function feed({ id, title, self, links = [], entries }) {
  const now = new Date().toISOString();
  const linkXml = [
    `<link rel="self" href="${xmlEscape(self)}" type="${NAV}"/>`,
    `<link rel="start" href="/opds/" type="${NAV}"/>`,
    `<link rel="search" href="/opds/search?q={searchTerms}" type="${ACQ}"/>`,
    ...links,
  ].join('\n  ');
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/terms/" xmlns:opds="http://opds-spec.org/2010/catalog">
  <id>${xmlEscape(id)}</id>
  <title>${xmlEscape(title)}</title>
  <updated>${now}</updated>
  ${linkXml}
  ${entries.join('\n  ')}
</feed>`;
}

function navEntry({ id, title, href, content }) {
  return `<entry>
    <id>${xmlEscape(id)}</id>
    <title>${xmlEscape(title)}</title>
    <updated>${new Date().toISOString()}</updated>
    <link rel="subsection" href="${xmlEscape(href)}" type="${NAV}"/>
    <content type="text">${xmlEscape(content || title)}</content>
  </entry>`;
}

function bookEntry(book) {
  const authors = book.authors
    .map((a) => `<author><name>${xmlEscape(a.full_name)}</name></author>`)
    .join('');
  const cats = book.genres
    .map((g) => `<category term="${xmlEscape(g.subsection)}"/>`)
    .join('');
  return `<entry>
    <id>book:${book.id}</id>
    <title>${xmlEscape(book.title)}</title>
    <updated>${new Date().toISOString()}</updated>
    ${authors}${cats}
    <link rel="http://opds-spec.org/acquisition" href="/api/books/${book.id}/download" type="${xmlEscape(mimeFor(book.format))}"/>
    <link rel="http://opds-spec.org/image" href="/api/books/${book.id}/cover" type="image/jpeg"/>
    <content type="text">${xmlEscape(book.annotation || book.title)}</content>
  </entry>`;
}

const send = (res, xml) => {
  res.setHeader('Content-Type', 'application/atom+xml; charset=utf-8');
  res.send(xml);
};

router.get('/', (req, res) => {
  const s = repo.stats();
  send(
    res,
    feed({
      id: 'sopds:root',
      title: config.title,
      self: '/opds/',
      entries: [
        navEntry({ id: 'nav:catalogs', title: 'By catalogs', href: '/opds/catalogs', content: `Catalogs: ${s.allcatalogs || 0}, books: ${s.allbooks || 0}` }),
        navEntry({ id: 'nav:authors', title: 'By authors', href: '/opds/authors', content: `Authors: ${s.allauthors || 0}` }),
        navEntry({ id: 'nav:series', title: 'By series', href: '/opds/series', content: `Series: ${s.allseries || 0}` }),
        navEntry({ id: 'nav:genres', title: 'By genres', href: '/opds/genres', content: `Genres: ${s.allgenres || 0}` }),
      ],
    }),
  );
});

router.get('/search', (req, res) => {
  const q = (req.query.q || '').toString().trim();
  const { items } = q ? repo.searchBooks(q, { limit: 60 }) : { items: [] };
  send(
    res,
    feed({
      id: `sopds:search:${q}`,
      title: `Search: ${q}`,
      self: `/opds/search?q=${encodeURIComponent(q)}`,
      entries: items.map(bookEntry),
    }),
  );
});

router.get('/catalogs', (req, res) => {
  const catId = req.query.cat ? Number(req.query.cat) : repo.rootCatalogId();
  const cats = repo.childCatalogs(catId);
  const { items } = repo.booksByCatalog(catId, { limit: 60 });
  send(
    res,
    feed({
      id: `sopds:catalogs:${catId || 0}`,
      title: 'By catalogs',
      self: `/opds/catalogs${catId ? `?cat=${catId}` : ''}`,
      entries: [
        ...cats.map((c) =>
          navEntry({
            id: `cat:${c.id}`,
            title: c.cat_name,
            href: `/opds/catalogs?cat=${c.id}`,
            content: `${c.book_count} books`,
          }),
        ),
        ...items.map(bookEntry),
      ],
    }),
  );
});

router.get('/authors', (req, res) => {
  const { items } = repo.listAuthors({ prefix: req.query.prefix || '', limit: 100 });
  send(
    res,
    feed({
      id: 'sopds:authors',
      title: 'By authors',
      self: '/opds/authors',
      entries: items.map((a) =>
        navEntry({
          id: `author:${a.id}`,
          title: a.full_name,
          href: `/opds/author/${a.id}`,
          content: `${a.book_count} books`,
        }),
      ),
    }),
  );
});

router.get('/author/:id', (req, res) => {
  const { items } = repo.booksByAuthor(Number(req.params.id), { limit: 100 });
  send(
    res,
    feed({
      id: `sopds:author:${req.params.id}`,
      title: 'Books by author',
      self: `/opds/author/${req.params.id}`,
      entries: items.map(bookEntry),
    }),
  );
});

router.get('/series', (req, res) => {
  const { items } = repo.listSeries({ prefix: req.query.prefix || '', limit: 100 });
  send(
    res,
    feed({
      id: 'sopds:series',
      title: 'By series',
      self: '/opds/series',
      entries: items.map((sr) =>
        navEntry({
          id: `series:${sr.id}`,
          title: sr.ser,
          href: `/opds/serie/${sr.id}`,
          content: `${sr.book_count} books`,
        }),
      ),
    }),
  );
});

router.get('/serie/:id', (req, res) => {
  const { items } = repo.booksBySeries(Number(req.params.id), { limit: 100 });
  send(
    res,
    feed({
      id: `sopds:serie:${req.params.id}`,
      title: 'Books in series',
      self: `/opds/serie/${req.params.id}`,
      entries: items.map(bookEntry),
    }),
  );
});

router.get('/genres', (req, res) => {
  const section = Number(req.query.section) || 0;
  if (!section) {
    send(
      res,
      feed({
        id: 'sopds:genres',
        title: 'By genres',
        self: '/opds/genres',
        entries: repo.genreSections().map((g) =>
          navEntry({
            id: `section:${g.section_id}`,
            title: g.section,
            href: `/opds/genres?section=${g.section_id}`,
            content: `${g.book_count} books`,
          }),
        ),
      }),
    );
    return;
  }
  send(
    res,
    feed({
      id: `sopds:genres:${section}`,
      title: 'Genre',
      self: `/opds/genres?section=${section}`,
      entries: repo.genresInSection(section).map((g) =>
        navEntry({
          id: `genre:${g.id}`,
          title: g.subsection,
          href: `/opds/genre/${g.id}`,
          content: `${g.book_count} books`,
        }),
      ),
    }),
  );
});

router.get('/genre/:id', (req, res) => {
  const { items } = repo.booksByGenre(Number(req.params.id), { limit: 100 });
  send(
    res,
    feed({
      id: `sopds:genre:${req.params.id}`,
      title: 'Books in genre',
      self: `/opds/genre/${req.params.id}`,
      entries: items.map(bookEntry),
    }),
  );
});

export default router;
