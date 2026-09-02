import React from 'react';
import { useParams, useSearchParams, Link as RouterLink } from 'react-router-dom';
import { Box, List, ListItemButton, ListItemText, Typography } from '@mui/material';
import { useApi } from '../api.js';
import { Async, BookGrid, Crumbs, Empty, Pager } from '../components/common.jsx';

function GenreBooks({ id }) {
  const [params, setParams] = useSearchParams();
  const page = Number(params.get('page')) || 1;
  const query = useApi(`/genres/${id}/books?page=${page}`, [id, page]);
  return (
    <Async query={query}>
      {(data) => (
        <Box>
          <Crumbs items={[{ label: 'Genres', to: '/genres' }, { label: 'Books' }]} />
          {data.items.length ? <BookGrid books={data.items} /> : <Empty />}
          <Pager meta={data} page={page} onChange={(p) => setParams({ page: String(p) })} />
        </Box>
      )}
    </Async>
  );
}

function GenreBrowse() {
  const [params] = useSearchParams();
  const section = params.get('section');
  const query = useApi(`/genres${section ? `?section=${section}` : ''}`, [section]);

  return (
    <Box>
      <Crumbs
        items={[
          { label: 'Genres', to: '/genres' },
          ...(section ? [{ label: 'Section' }] : []),
        ]}
      />
      <Typography variant="h5" gutterBottom>
        Genres
      </Typography>
      <Async query={query}>
        {(items) =>
          items.length ? (
            <List>
              {items.map((g) =>
                section ? (
                  <ListItemButton key={g.id} component={RouterLink} to={`/genres/${g.id}`}>
                    <ListItemText primary={g.subsection} secondary={`${g.book_count} book(s)`} />
                  </ListItemButton>
                ) : (
                  <ListItemButton
                    key={g.section_id}
                    component={RouterLink}
                    to={`/genres?section=${g.section_id}`}
                  >
                    <ListItemText primary={g.section} secondary={`${g.book_count} book(s)`} />
                  </ListItemButton>
                ),
              )}
            </List>
          ) : (
            <Empty />
          )
        }
      </Async>
    </Box>
  );
}

export default function Genres() {
  const { id } = useParams();
  return id ? <GenreBooks id={id} /> : <GenreBrowse />;
}
