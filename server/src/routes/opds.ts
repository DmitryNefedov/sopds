import { Router } from 'express';
import type { Response } from 'express';
import * as repo from '../repo.js';
import config from '../config.js';
import { S } from '../settings.js';
import { mimeFor } from '../files.js';
import { CONVERTIBLE } from '../convert/index.js';
import { ah, qstr } from '../http.js';
import type { Book } from '../types.js';

// Minimal OPDS 1.1 (Atom) catalog so existing OPDS readers keep working.
const router = Router();

const xmlEscape = (s: unknown): string =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const NAV = 'application/atom+xml;profile=opds-catalog;kind=navigation';
const ACQ = 'application/atom+xml;profile=opds-catalog;kind=acquisition';

interface FeedArgs {
  id: string;
  title: string;
  self: string;
  links?: string[];
  entries: string[];
}
function feed({ id, title, self, links = [], entries }: FeedArgs): string {
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

interface NavEntryArgs {
  id: string;
  title: string;
  href: string;
  content?: string;
}
function navEntry({ id, title, href, content }: NavEntryArgs): string {
  return `<entry>
    <id>${xmlEscape(id)}</id>
    <title>${xmlEscape(title)}</title>
    <updated>${new Date().toISOString()}</updated>
    <link rel="subsection" href="${xmlEscape(href)}" type="${NAV}"/>
    <content type="text">${xmlEscape(content || title)}</content>
  </entry>`;
}

function bookEntry(book: Book): string {
  const authors = book.authors
    .map((a) => `<author><name>${xmlEscape(a.full_name)}</name></author>`)
    .join('');
  const cats = book.genres
    .map((g) => `<category term="${xmlEscape(g.subsection)}"/>`)
    .join('');
  // Offer the native file plus every format we can convert to.
  const formats = [
    book.format,
    ...config.downloadFormats.filter(
      (f) => f !== book.format && (CONVERTIBLE as readonly string[]).includes(book.format),
    ),
  ];
  const acquisition = formats
    .map(
      (f) =>
        `<link rel="http://opds-spec.org/acquisition/open-access" href="/api/books/${book.id}/download?format=${f}" type="${xmlEscape(mimeFor(f))}"/>`,
    )
    .join('\n    ');
  return `<entry>
    <id>book:${book.id}</id>
    <title>${xmlEscape(book.title)}</title>
    <updated>${new Date().toISOString()}</updated>
    ${authors}${cats}
    ${acquisition}
    <link rel="http://opds-spec.org/image" href="/api/books/${book.id}/cover" type="image/jpeg"/>
    <content type="text">${xmlEscape(book.annotation || book.title)}</content>
  </entry>`;
}

const send = (res: Response, xml: string): void => {
  res.setHeader('Content-Type', 'application/atom+xml; charset=utf-8');
  res.send(xml);
};

router.get('/', ah(async (_req, res) => {
  const s = await repo.stats();
  send(
    res,
    feed({
      id: 'sopds:root',
      title: S.title,
      self: '/opds/',
      entries: [
        navEntry({ id: 'nav:catalogs', title: 'By catalogs', href: '/opds/catalogs', content: `Catalogs: ${s.allcatalogs || 0}, books: ${s.allbooks || 0}` }),
        navEntry({ id: 'nav:authors', title: 'By authors', href: '/opds/authors', content: `Authors: ${s.allauthors || 0}` }),
        navEntry({ id: 'nav:series', title: 'By series', href: '/opds/series', content: `Series: ${s.allseries || 0}` }),
        navEntry({ id: 'nav:genres', title: 'By genres', href: '/opds/genres', content: `Genres: ${s.allgenres || 0}` }),
      ],
    }),
  );
}));

router.get('/search', ah(async (req, res) => {
  const q = qstr(req.query.q).trim();
  const { items } = q ? await repo.searchBooks(q, { limit: 60 }) : { items: [] as Book[] };
  send(
    res,
    feed({
      id: `sopds:search:${q}`,
      title: `Search: ${q}`,
      self: `/opds/search?q=${encodeURIComponent(q)}`,
      entries: items.map(bookEntry),
    }),
  );
}));

router.get('/catalogs', ah(async (req, res) => {
  const catId = req.query.cat ? Number(req.query.cat) : await repo.rootCatalogId();
  const cats = await repo.childCatalogs(catId);
  const { items } = await repo.booksByCatalog(catId, { limit: 60 });
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
}));

router.get('/authors', ah(async (req, res) => {
  const { items } = await repo.listAuthors({ prefix: qstr(req.query.prefix), limit: 100 });
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
}));

router.get('/author/:id', ah(async (req, res) => {
  const { items } = await repo.booksByAuthor(Number(req.params.id), { limit: 100 });
  send(
    res,
    feed({
      id: `sopds:author:${req.params.id}`,
      title: 'Books by author',
      self: `/opds/author/${req.params.id}`,
      entries: items.map(bookEntry),
    }),
  );
}));

router.get('/series', ah(async (req, res) => {
  const { items } = await repo.listSeries({ prefix: qstr(req.query.prefix), limit: 100 });
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
}));

router.get('/serie/:id', ah(async (req, res) => {
  const { items } = await repo.booksBySeries(Number(req.params.id), { limit: 100 });
  send(
    res,
    feed({
      id: `sopds:serie:${req.params.id}`,
      title: 'Books in series',
      self: `/opds/serie/${req.params.id}`,
      entries: items.map(bookEntry),
    }),
  );
}));

router.get('/genres', ah(async (req, res) => {
  const section = Number(req.query.section) || 0;
  if (!section) {
    send(
      res,
      feed({
        id: 'sopds:genres',
        title: 'By genres',
        self: '/opds/genres',
        entries: (await repo.genreSections()).map((g) =>
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
      entries: (await repo.genresInSection(section)).map((g) =>
        navEntry({
          id: `genre:${g.id}`,
          title: g.subsection,
          href: `/opds/genre/${g.id}`,
          content: `${g.book_count} books`,
        }),
      ),
    }),
  );
}));

router.get('/genre/:id', ah(async (req, res) => {
  const { items } = await repo.booksByGenre(Number(req.params.id), { limit: 100 });
  send(
    res,
    feed({
      id: `sopds:genre:${req.params.id}`,
      title: 'Books in genre',
      self: `/opds/genre/${req.params.id}`,
      entries: items.map(bookEntry),
    }),
  );
}));

export default router;
