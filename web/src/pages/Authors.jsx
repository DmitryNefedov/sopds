import React, { useState } from 'react';
import { useParams, useSearchParams, Link as RouterLink } from 'react-router-dom';
import { Box, List, ListItemButton, ListItemText, TextField, Typography } from '@mui/material';
import { useApi } from '../api.js';
import { Async, BookGrid, Crumbs, Empty, Pager } from '../components/common.jsx';

function AuthorBooks({ id }) {
  const [params, setParams] = useSearchParams();
  const page = Number(params.get('page')) || 1;
  const query = useApi(`/authors/${id}/books?page=${page}`, [id, page]);
  return (
    <Async query={query}>
      {(data) => (
        <Box>
          <Crumbs
            items={[
              { label: 'Authors', to: '/authors' },
              { label: data.items[0]?.authors.find((a) => a.id === Number(id))?.full_name || 'Author' },
            ]}
          />
          {data.items.length ? <BookGrid books={data.items} /> : <Empty />}
          <Pager meta={data} page={page} onChange={(p) => setParams({ page: String(p) })} />
        </Box>
      )}
    </Async>
  );
}

function AuthorBrowse() {
  const [params, setParams] = useSearchParams();
  const prefix = params.get('prefix') || '';
  const page = Number(params.get('page')) || 1;
  const [input, setInput] = useState(prefix);
  const query = useApi(
    `/authors?prefix=${encodeURIComponent(prefix)}&page=${page}`,
    [prefix, page],
  );

  return (
    <Box>
      <Typography variant="h5" gutterBottom>
        Authors
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
                {data.items.map((a) => (
                  <ListItemButton key={a.id} component={RouterLink} to={`/authors/${a.id}`}>
                    <ListItemText primary={a.full_name} secondary={`${a.book_count} book(s)`} />
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

export default function Authors() {
  const { id } = useParams();
  return id ? <AuthorBooks id={id} /> : <AuthorBrowse />;
}
