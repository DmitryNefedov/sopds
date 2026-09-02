import React, { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Box, TextField, Typography } from '@mui/material';
import { useApi } from '../api.js';
import { Async, BookGrid, Empty, Pager } from '../components/common.jsx';

export default function BookList() {
  const [params, setParams] = useSearchParams();
  const prefix = params.get('prefix') || '';
  const page = Number(params.get('page')) || 1;
  const [input, setInput] = useState(prefix);
  const query = useApi(
    `/books?prefix=${encodeURIComponent(prefix)}&page=${page}`,
    [prefix, page],
  );

  return (
    <Box>
      <Typography variant="h5" gutterBottom>
        Books
      </Typography>
      <TextField
        fullWidth
        size="small"
        label="Title starts with"
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
            {data.items.length ? <BookGrid books={data.items} /> : <Empty />}
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
