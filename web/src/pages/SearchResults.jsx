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
import { useApi } from '../api.js';
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
              <Box
                component="button"
                onClick={seeAll}
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
                See all {results.total}
              </Box>
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
  const books = useApi(previewUrl('books'), [q, overview]);
  const authors = useApi(previewUrl('authors'), [q, overview]);
  const series = useApi(previewUrl('series'), [q, overview]);

  const single = useApi(
    !overview && q ? `/search?q=${qs}&type=${tab}&page=${page}` : null,
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
          <ResultSection
            title="Books"
            query={books}
            render={(items) => <BookResults items={items} />}
            seeAll={() => setTab('books')}
          />
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
      ) : (
        <Async query={single}>
          {(data) => {
            const r = data.results;
            if (!r) return <Empty />;
            return (
              <>
                {tab === 'books' && <BookResults items={r.items} />}
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
