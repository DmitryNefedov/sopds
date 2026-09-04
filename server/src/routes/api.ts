import { Router } from 'express';
import type { Request } from 'express';
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
import { ah, qstr } from '../http.js';
import type { PageOpts } from '../types.js';

const router = Router();

const opts = (req: Request): PageOpts => ({
  page: qstr(req.query.page) || undefined,
  limit: qstr(req.query.limit) || undefined,
});

// ---- unified search ----------------------------------------------------
// GET /api/search?q=...&type=all|books|authors|series
router.get(
  '/search',
  ah(async (req, res) => {
    const q = qstr(req.query.q).trim();
    const type = qstr(req.query.type, 'all');
    if (!q) return res.json({ query: '', type, results: null });
    if (type === 'books')
      return res.json({ query: q, type, results: await repo.searchBooks(q, opts(req)) });
    if (type === 'authors')
      return res.json({ query: q, type, results: await repo.searchAuthors(q, opts(req)) });
    if (type === 'series')
      return res.json({ query: q, type, results: await repo.searchSeries(q, opts(req)) });
    return res.json({ query: q, type: 'all', results: await repo.searchAll(q) });
  }),
);

// ---- books -----------------------------------------------------------
router.get(
  '/books',
  ah(async (req, res) => {
    res.json(
      await repo.listBooks({
        prefix: qstr(req.query.prefix),
        langCode: Number(req.query.lang) || 0,
        ...opts(req),
      }),
    );
  }),
);

router.get(
  '/books/:id',
  ah(async (req, res) => {
    const book = await repo.getBook(Number(req.params.id));
    if (!book) return res.status(404).json({ error: 'not found' });
    // Every book is offered in all download formats; the native one is marked.
    book.download_formats = config.downloadFormats.map((fmt) => ({
      format: fmt,
      native: fmt === book.format,
      convertible: (CONVERTIBLE as readonly string[]).includes(book.format) || fmt === book.format,
      url: `/api/books/${book.id}/download?format=${fmt}`,
    }));
    res.json(book);
  }),
);

router.get(
  '/books/:id/download',
  ah(async (req, res) => {
    const book = await repo.getBook(Number(req.params.id));
    if (!book) return res.status(404).json({ error: 'not found' });
    let buf: Buffer;
    try {
      buf = await readBookBytes(book);
    } catch {
      return res.status(404).json({ error: 'file missing' });
    }

    const target = (qstr(req.query.format) || book.format).toLowerCase();
    try {
      if (target !== book.format) {
        buf = await convert(buf, book.format, target, `book:${book.id}`);
      }
    } catch (err) {
      const status = err instanceof ConvertError ? err.status : 500;
      return res.status(status).json({ error: (err as Error).message });
    }

    const base = translitName(book.title);
    if (qstr(req.query.zip) === '1') {
      const out = zipWrap(buf, `${base}.${target}`);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${base}.${target}.zip"`);
      return res.send(out);
    }
    res.setHeader('Content-Type', mimeFor(target));
    res.setHeader('Content-Disposition', `attachment; filename="${base}.${target}"`);
    res.send(buf);
  }),
);

router.get(
  '/books/:id/cover',
  ah(async (req, res) => {
    // A cover only needs the bytes, so skip the author/genre/series joins.
    const book = await repo.getBookRef(Number(req.params.id));
    if (!book) return res.status(404).end();
    res.setHeader('Cache-Control', 'public, max-age=86400');

    const img = await readBookCover(book);
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
  }),
);

// ---- authors -------------------------------------------------------
router.get(
  '/authors',
  ah(async (req, res) => {
    res.json(
      await repo.listAuthors({
        prefix: qstr(req.query.prefix),
        langCode: Number(req.query.lang) || 0,
        ...opts(req),
      }),
    );
  }),
);
router.get(
  '/authors/:id/books',
  ah(async (req, res) => {
    res.json(await repo.booksByAuthor(Number(req.params.id), opts(req)));
  }),
);

// ---- series -------------------------------------------------------
router.get(
  '/series',
  ah(async (req, res) => {
    res.json(
      await repo.listSeries({
        prefix: qstr(req.query.prefix),
        langCode: Number(req.query.lang) || 0,
        ...opts(req),
      }),
    );
  }),
);
router.get(
  '/series/:id/books',
  ah(async (req, res) => {
    res.json(await repo.booksBySeries(Number(req.params.id), opts(req)));
  }),
);

// ---- genres ------------------------------------------------------
router.get(
  '/genres',
  ah(async (req, res) => {
    const section = Number(req.query.section) || 0;
    res.json(section ? await repo.genresInSection(section) : await repo.genreSections());
  }),
);
router.get(
  '/genres/:id/books',
  ah(async (req, res) => {
    res.json(await repo.booksByGenre(Number(req.params.id), opts(req)));
  }),
);

// ---- catalogs ---------------------------------------------------
router.get(
  '/catalogs',
  ah(async (req, res) => {
    const catId = req.query.cat ? Number(req.query.cat) : await repo.rootCatalogId();
    const [breadcrumbs, catalogs, books] = await Promise.all([
      repo.catalogBreadcrumbs(catId),
      repo.childCatalogs(catId),
      repo.booksByCatalog(catId, opts(req)),
    ]);
    res.json({ breadcrumbs, catalogs, books });
  }),
);

// ---- meta -----------------------------------------------------
router.get(
  '/stats',
  ah(async (_req, res) => {
    res.json({
      ...(await repo.stats()),
      title: S.title,
      subtitle: S.subtitle,
      lang_menu: LANG_MENU,
    });
  }),
);
router.get('/random', ah(async (_req, res) => res.json(await repo.randomBook())));
router.get('/convert-info', (_req, res) => res.json(converterInfo()));

export default router;
