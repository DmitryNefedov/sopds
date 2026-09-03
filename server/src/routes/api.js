import { Router } from 'express';
import * as repo from '../repo.js';
import config from '../config.js';
import { LANG_MENU } from '../lang.js';
import {
  readBookBytes,
  readBookCover,
  mimeFor,
  zipWrap,
  translitName,
  nocover,
} from '../files.js';
import { S } from '../settings.js';
import { convert, CONVERTIBLE, converterInfo, ConvertError } from '../convert/index.js';

const router = Router();

const opts = (req) => ({
  page: req.query.page,
  limit: req.query.limit,
});

// ---- unified search ----------------------------------------------------
// GET /api/search?q=...&type=all|books|authors|series
router.get('/search', (req, res) => {
  const q = (req.query.q || '').toString().trim();
  const type = (req.query.type || 'all').toString();
  if (!q) return res.json({ query: '', type, results: null });
  if (type === 'books')
    return res.json({ query: q, type, results: repo.searchBooks(q, opts(req)) });
  if (type === 'authors')
    return res.json({ query: q, type, results: repo.searchAuthors(q, opts(req)) });
  if (type === 'series')
    return res.json({ query: q, type, results: repo.searchSeries(q, opts(req)) });
  return res.json({ query: q, type: 'all', results: repo.searchAll(q) });
});

// ---- books -----------------------------------------------------------
router.get('/books', (req, res) => {
  res.json(
    repo.listBooks({
      prefix: req.query.prefix || '',
      langCode: Number(req.query.lang) || 0,
      ...opts(req),
    }),
  );
});

router.get('/books/:id', (req, res) => {
  const book = repo.getBook(Number(req.params.id));
  if (!book) return res.status(404).json({ error: 'not found' });
  // Every book is offered in all download formats; the native one is marked.
  book.download_formats = config.downloadFormats.map((fmt) => ({
    format: fmt,
    native: fmt === book.format,
    convertible: CONVERTIBLE.includes(book.format) || fmt === book.format,
    url: `/api/books/${book.id}/download?format=${fmt}`,
  }));
  res.json(book);
});

router.get('/books/:id/download', (req, res) => {
  const book = repo.getBook(Number(req.params.id));
  if (!book) return res.status(404).json({ error: 'not found' });
  let buf;
  try {
    buf = readBookBytes(book);
  } catch {
    return res.status(404).json({ error: 'file missing' });
  }

  const target = (req.query.format || book.format).toString().toLowerCase();
  try {
    if (target !== book.format) {
      buf = convert(buf, book.format, target, `book:${book.id}`);
    }
  } catch (err) {
    const status = err instanceof ConvertError ? err.status : 500;
    return res.status(status).json({ error: err.message });
  }

  const base = translitName(book.title);
  if (req.query.zip === '1') {
    const out = zipWrap(buf, `${base}.${target}`);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${base}.${target}.zip"`,
    );
    return res.send(out);
  }
  res.setHeader('Content-Type', mimeFor(target));
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${base}.${target}"`,
  );
  res.send(buf);
});

router.get('/books/:id/cover', (req, res) => {
  const book = repo.getBook(Number(req.params.id));
  if (!book) return res.status(404).end();
  res.setHeader('Cache-Control', 'public, max-age=86400');

  const img = readBookCover(book);
  if (img && img.data && img.data.length) {
    res.setHeader('Content-Type', img.mime || 'image/jpeg');
    return res.send(img.data);
  }

  const fallback = nocover();
  if (fallback) {
    res.setHeader('Content-Type', fallback.type);
    res.setHeader('X-Cover', 'default');
    return res.send(fallback.data);
  }
  res.status(404).end();
});

// ---- authors -------------------------------------------------------
router.get('/authors', (req, res) => {
  res.json(
    repo.listAuthors({
      prefix: req.query.prefix || '',
      langCode: Number(req.query.lang) || 0,
      ...opts(req),
    }),
  );
});
router.get('/authors/:id/books', (req, res) => {
  res.json(repo.booksByAuthor(Number(req.params.id), opts(req)));
});

// ---- series -------------------------------------------------------
router.get('/series', (req, res) => {
  res.json(
    repo.listSeries({
      prefix: req.query.prefix || '',
      langCode: Number(req.query.lang) || 0,
      ...opts(req),
    }),
  );
});
router.get('/series/:id/books', (req, res) => {
  res.json(repo.booksBySeries(Number(req.params.id), opts(req)));
});

// ---- genres ------------------------------------------------------
router.get('/genres', (req, res) => {
  const section = Number(req.query.section) || 0;
  res.json(section ? repo.genresInSection(section) : repo.genreSections());
});
router.get('/genres/:id/books', (req, res) => {
  res.json(repo.booksByGenre(Number(req.params.id), opts(req)));
});

// ---- catalogs ---------------------------------------------------
router.get('/catalogs', (req, res) => {
  const catId = req.query.cat ? Number(req.query.cat) : repo.rootCatalogId();
  res.json({
    breadcrumbs: repo.catalogBreadcrumbs(catId),
    catalogs: repo.childCatalogs(catId),
    books: repo.booksByCatalog(catId, opts(req)),
  });
});

// ---- meta -----------------------------------------------------
router.get('/stats', (req, res) => {
  res.json({
    ...repo.stats(),
    title: S.title,
    subtitle: S.subtitle,
    lang_menu: LANG_MENU,
  });
});
router.get('/random', (req, res) => res.json(repo.randomBook()));
router.get('/convert-info', (req, res) => res.json(converterInfo()));

export default router;
