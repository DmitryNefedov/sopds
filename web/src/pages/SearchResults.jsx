import React from 'react';
import { useSearchParams, Link as RouterLink } from 'react-router-dom';
import {
  Box,
  Divider,
  LinearProgress,
  List,
  ListItemButton,
  ListItemText,
  Tab,
  Tabs,
  Typography,
} from '@mui/material';
import { useApi, useBookSearch } from '../api.js';
import { Async, BookGrid, Empty, ErrorState, Pager } from '../components/common.jsx';

const PREVIEW_LIMIT = 10;

function AuthorList({ items }) {
  if (!items.length) return <Empty>No matching authors.</Empty>;
  return (
    <List>
      {items.map((a) => (
        <ListItemButton key={a.id} component={RouterLink} to={`/authors/${a.id}`}>
          <ListItemText primary={a.full_name} secondary={`${a.book_count} book(s)`} />
        </ListItemButton>
      ))}
    </List>
  );
}

function SeriesList({ items }) {
  if (!items.length) return <Empty>No matching series.</Empty>;
  return (
    <List>
      {items.map((s) => (
        <ListItemButton key={s.id} component={RouterLink} to={`/series/${s.id}`}>
          <ListItemText primary={s.ser} secondary={`${s.book_count} book(s)`} />
        </ListItemButton>
      ))}
    </List>
  );
}

function BookResults({ items }) {
  if (!items.length) return <Empty>No matching books.</Empty>;
  return <BookGrid books={items} />;
}

/** The "See all N" link under a section, styled as a link but really a button
 *  because it switches tab rather than navigating. */
function SeeAll({ onClick, children }) {
  return (
    <Box
      component="button"
      onClick={onClick}
      sx={{
        background: 'none',
        border: 0,
        p: 0,
        cursor: 'pointer',
        font: 'inherit',
        color: 'primary.main',
        textDecoration: 'underline',
      }}
    >
      {children}
    </Box>
  );
}

/**
 * The books half of a search, in two passes. The anchored pass usually lands
 * first and its results are rendered immediately — fully interactive, covers
 * and download buttons and all — while the full substring pass is still
 * running. When that lands its extra results are appended below.
 */
function BookPhase({ search, children }) {
  const { items, meta, phase, error, reload } = search;
  const partial = phase === 'partial';
  // A failed search that still has quick matches keeps showing them: they are
  // real results, and the error only says the rest could not be fetched.
  if (error && !items.length) return <ErrorState error={error} onRetry={reload} />;
  return (
    <>
      {(phase === 'loading' || partial) && <LinearProgress sx={{ mb: 1 }} />}
      {error && <ErrorState error={error} onRetry={reload} />}
      {partial && (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          Showing {items.length} quick {items.length === 1 ? 'match' : 'matches'} — still
          searching the rest of the catalog…
        </Typography>
      )}
      {phase !== 'loading' && <BookResults items={items} />}
      {children?.({ meta, phase })}
    </>
  );
}

/** The count in a section heading, which is unknown until the full pass lands. */
function BookCount({ search }) {
  if (search.phase === 'partial') return <span>(searching…)</span>;
  if (!search.meta) return null;
  return <span>({search.meta.total})</span>;
}

/**
 * One section of the overview. Each type is fetched by its own request, so a
 * section paints the moment its own results land instead of waiting for the
 * slowest of the three — books usually take much longer than authors or series,
 * and there is no reason to hold those back.
 */
function ResultSection({ title, query, render, seeAll }) {
  const { data, loading, error, reload } = query;
  const results = data?.results;
  return (
    <Box sx={{ mb: 4 }}>
      <Typography variant="h6" gutterBottom>
        {title}{' '}
        {results && (
          <Typography component="span" color="text.secondary">
            ({results.total})
          </Typography>
        )}
      </Typography>
      {/* A slim bar rather than a spinner: the heading stays put while the
          section fills in, so the page does not jump as each one arrives. */}
      {loading && <LinearProgress sx={{ mb: 1 }} />}
      {error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : results ? (
        <>
          {render(results.items)}
          {results.total > results.items.length && (
            <Typography variant="body2" sx={{ mt: 1 }}>
              <SeeAll onClick={seeAll}>See all {results.total}</SeeAll>
            </Typography>
          )}
        </>
      ) : null}
    </Box>
  );
}

export default function SearchResults() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') || '';
  const tab = params.get('type') || 'all';
  const page = Number(params.get('page')) || 1;

  const setTab = (t) => setParams({ q, type: t, ...(t === 'all' ? {} : { page: '1' }) });
  const setPage = (p) => setParams({ q, type: tab, page: String(p) });

  const overview = tab === 'all';
  const qs = encodeURIComponent(q);
  // The overview is three independent requests rather than one combined call:
  // they run in parallel and each section paints as its own results land,
  // instead of every section waiting on the slowest.
  const previewUrl = (type) =>
    overview && q ? `/search?q=${qs}&type=${type}&page=1&limit=${PREVIEW_LIMIT}` : null;
  const authors = useApi(previewUrl('authors'), [q, overview]);
  const series = useApi(previewUrl('series'), [q, overview]);
  // Books run as two passes of their own, so the section can paint the fast
  // half while the slow one is still in flight.
  const books = useBookSearch(overview ? q : '', { limit: PREVIEW_LIMIT });

  const singleBooks = useBookSearch(!overview && tab === 'books' ? q : '', { page });
  const single = useApi(
    !overview && tab !== 'books' && q ? `/search?q=${qs}&type=${tab}&page=${page}` : null,
    [q, tab, page, overview],
  );

  if (!q) return <Empty>Type a query in the search bar above.</Empty>;

  return (
    <Box>
      <Typography variant="h5" gutterBottom>
        Results for “{q}”
      </Typography>
      <Tabs value={tab} onChange={(_, t) => setTab(t)} sx={{ mb: 2 }}>
        <Tab label="Overview" value="all" />
        <Tab label="Books" value="books" />
        <Tab label="Authors" value="authors" />
        <Tab label="Series" value="series" />
      </Tabs>

      {overview ? (
        // Books first and always shown, even when nothing matched: it is the
        // result people are looking for, and a section that appears only
        // sometimes moves everything below it around.
        <>
          <Box sx={{ mb: 4 }}>
            <Typography variant="h6" gutterBottom>
              Books{' '}
              <Typography component="span" color="text.secondary">
                <BookCount search={books} />
              </Typography>
            </Typography>
            <BookPhase search={books}>
              {({ meta }) =>
                meta && meta.total > books.items.length ? (
                  <Typography variant="body2" sx={{ mt: 1 }}>
                    <SeeAll onClick={() => setTab('books')}>See all {meta.total}</SeeAll>
                  </Typography>
                ) : null
              }
            </BookPhase>
          </Box>
          <Divider />
          <ResultSection
            title="Authors"
            query={authors}
            render={(items) => <AuthorList items={items} />}
            seeAll={() => setTab('authors')}
          />
          <Divider />
          <ResultSection
            title="Series"
            query={series}
            render={(items) => <SeriesList items={items} />}
            seeAll={() => setTab('series')}
          />
        </>
      ) : tab === 'books' ? (
        <BookPhase search={singleBooks}>
          {({ meta }) => <Pager meta={meta} page={page} onChange={setPage} />}
        </BookPhase>
      ) : (
        <Async query={single}>
          {(data) => {
            const r = data.results;
            if (!r) return <Empty />;
            return (
              <>
                {tab === 'authors' && <AuthorList items={r.items} />}
                {tab === 'series' && <SeriesList items={r.items} />}
                <Pager meta={r} page={page} onChange={setPage} />
              </>
            );
          }}
        </Async>
      )}
    </Box>
  );
}
