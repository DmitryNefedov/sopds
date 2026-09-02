import React, { useState } from 'react';
import { useParams, useSearchParams, Link as RouterLink } from 'react-router-dom';
import { Box, List, ListItemButton, ListItemText, TextField, Typography } from '@mui/material';
import { useApi } from '../api.js';
import { Async, BookGrid, Crumbs, Empty, Pager } from '../components/common.jsx';

function SeriesBooks({ id }) {
  const [params, setParams] = useSearchParams();
  const page = Number(params.get('page')) || 1;
  const query = useApi(`/series/${id}/books?page=${page}`, [id, page]);
  return (
    <Async query={query}>
      {(data) => (
        <Box>
          <Crumbs
            items={[
              { label: 'Series', to: '/series' },
              { label: data.items[0]?.series.find((s) => s.id === Number(id))?.ser || 'Series' },
            ]}
          />
          {data.items.length ? <BookGrid books={data.items} /> : <Empty />}
          <Pager meta={data} page={page} onChange={(p) => setParams({ page: String(p) })} />
        </Box>
      )}
    </Async>
  );
}

function SeriesBrowse() {
  const [params, setParams] = useSearchParams();
  const prefix = params.get('prefix') || '';
  const page = Number(params.get('page')) || 1;
  const [input, setInput] = useState(prefix);
  const query = useApi(
    `/series?prefix=${encodeURIComponent(prefix)}&page=${page}`,
    [prefix, page],
  );

  return (
    <Box>
      <Typography variant="h5" gutterBottom>
        Series
      </Typography>
      <TextField
        fullWidth
        size="small"
        label="Starts with"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') setParams({ prefix: input, page: '1' });
        }}
        sx={{ mb: 2 }}
      />
      <Async query={query}>
        {(data) => (
          <>
            {data.items.length ? (
              <List>
                {data.items.map((s) => (
                  <ListItemButton key={s.id} component={RouterLink} to={`/series/${s.id}`}>
                    <ListItemText primary={s.ser} secondary={`${s.book_count} book(s)`} />
                  </ListItemButton>
                ))}
              </List>
            ) : (
              <Empty />
            )}
            <Pager
              meta={data}
              page={page}
              onChange={(p) => setParams({ prefix, page: String(p) })}
            />
          </>
        )}
      </Async>
    </Box>
  );
}

export default function Series() {
  const { id } = useParams();
  return id ? <SeriesBooks id={id} /> : <SeriesBrowse />;
}
