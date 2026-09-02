import React, { useState } from 'react';
import { useSearchParams, Link as RouterLink } from 'react-router-dom';
import {
  Box,
  Card,
  CardActionArea,
  CardContent,
  Divider,
  List,
  ListItemButton,
  ListItemText,
  Tab,
  Tabs,
  Typography,
} from '@mui/material';
import { useApi } from '../api.js';
import { Async, BookGrid, Empty, Pager } from '../components/common.jsx';

function AuthorList({ items }) {
  if (!items.length) return <Empty>No matching authors.</Empty>;
  return (
    <List>
      {items.map((a) => (
        <ListItemButton
          key={a.id}
          component={RouterLink}
          to={`/authors/${a.id}`}
        >
          <ListItemText
            primary={a.full_name}
            secondary={`${a.book_count} book(s)`}
          />
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

function Section({ title, count, children }) {
  return (
    <Box sx={{ mb: 4 }}>
      <Typography variant="h6" gutterBottom>
        {title} {count != null && <Typography component="span" color="text.secondary">({count})</Typography>}
      </Typography>
      {children}
    </Box>
  );
}

export default function SearchResults() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') || '';
  const tab = params.get('type') || 'all';
  const page = Number(params.get('page')) || 1;

  const setTab = (t) =>
    setParams({ q, type: t, ...(t === 'all' ? {} : { page: '1' }) });
  const setPage = (p) => setParams({ q, type: tab, page: String(p) });

  const query = useApi(
    `/search?q=${encodeURIComponent(q)}&type=${tab}&page=${page}`,
    [q, tab, page],
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

      <Async query={query}>
        {(data) => {
          const r = data.results;
          if (!r) return <Empty />;
          if (tab === 'all') {
            return (
              <>
                <Section title="Authors" count={r.authors.total}>
                  <AuthorList items={r.authors.items} />
                </Section>
                <Divider />
                <Section title="Series" count={r.series.total}>
                  <SeriesList items={r.series.items} />
                </Section>
                <Divider />
                <Section title="Books" count={r.books.total}>
                  {r.books.items.length ? (
                    <BookGrid books={r.books.items} />
                  ) : (
                    <Empty>No matching books.</Empty>
                  )}
                </Section>
              </>
            );
          }
          if (tab === 'books') {
            return (
              <>
                {r.items.length ? <BookGrid books={r.items} /> : <Empty />}
                <Pager meta={r} page={page} onChange={setPage} />
              </>
            );
          }
          if (tab === 'authors') {
            return (
              <>
                <AuthorList items={r.items} />
                <Pager meta={r} page={page} onChange={setPage} />
              </>
            );
          }
          return (
            <>
              <SeriesList items={r.items} />
              <Pager meta={r} page={page} onChange={setPage} />
            </>
          );
        }}
      </Async>
    </Box>
  );
}
